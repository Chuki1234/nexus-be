import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as os from 'os';
import { SupabaseService } from '../supabase/supabase.service';

export interface StorageCleanupItem {
  id: string;
  bucket: string;
  storage_path: string;
  attempts: number;
}

@Injectable()
export class StorageCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageCleanupWorker.name);
  readonly workerId: string;

  private workerTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private readonly supabase: SupabaseService) {
    this.workerId = `storage-worker-${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  }

  onModuleInit(): void {
    // Chạy định kỳ mỗi 15s nếu không trong môi trường test
    if (process.env.NODE_ENV !== 'test') {
      this.workerTimer = setInterval(() => {
        void this.processBatch();
      }, 15000);
    }
  }

  onModuleDestroy(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  /**
   * Thực thi claim batch và xóa storage files bằng SQL FOR UPDATE SKIP LOCKED
   */
  async processBatch(batchSize = 50): Promise<{ claimed: number; succeeded: number; failed: number }> {
    if (this.isProcessing) {
      return { claimed: 0, succeeded: 0, failed: 0 };
    }
    this.isProcessing = true;

    let succeeded = 0;
    let failed = 0;

    try {
      // 1. Claim batch các bản ghi cần xử lý bằng RPC hoặc direct query
      // Nếu Supabase client hỗ trợ raw SQL qua RPC
      const { data: claimedRows, error: claimErr } = await this.supabase.client.rpc(
        'claim_storage_cleanup_batch',
        {
          p_worker_id: this.workerId,
          p_limit: batchSize,
        },
      );

      if (claimErr) {
        this.logger.error(
          `RPC claim_storage_cleanup_batch thất bại (fail-closed): ${claimErr.message}`,
        );
        return { claimed: 0, succeeded: 0, failed: 0 };
      }

      const rows: StorageCleanupItem[] = claimedRows || [];
      if (rows.length === 0) {
        return { claimed: 0, succeeded: 0, failed: 0 };
      }

      this.logger.log(`Worker ${this.workerId} đã claim ${rows.length} files cần dọn dẹp`);

      // 2. Xử lý từng file
      for (const item of rows) {
        const ok = await this.processItem(item);
        if (ok) succeeded++;
        else failed++;
      }

      return { claimed: rows.length, succeeded, failed };
    } finally {
      this.isProcessing = false;
    }
  }

  private async processItem(item: StorageCleanupItem): Promise<boolean> {
    try {
      // Xóa file khỏi Supabase Storage
      const { error: removeErr } = await this.supabase.client.storage
        .from(item.bucket)
        .remove([item.storage_path]);

      // 404 (file không tồn tại hoặc đã xóa) vẫn coi là thành công
      if (removeErr && !removeErr.message?.includes('404') && !removeErr.message?.toLowerCase().includes('not found')) {
        throw new Error(removeErr.message);
      }

      // Success Fencing Update: status='processing' and locked_by=workerId
      const { error: updateErr } = await this.supabase.client
        .from('storage_cleanup_outbox')
        .update({
          status: 'completed',
          locked_by: null,
          locked_at: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('status', 'processing')
        .eq('locked_by', this.workerId);

      if (updateErr) {
        this.logger.warn(`Lỗi cập nhật completed cho outbox ${item.id}: ${updateErr.message}`);
      }

      return true;
    } catch (err: any) {
      this.logger.error(`Lỗi xóa storage file ${item.storage_path}: ${err.message}`);

      // Capped exponential backoff: min(300, 5 * 2^attempts)
      const nextDelaySec = Math.min(300, 5 * Math.pow(2, item.attempts));
      const nextAttemptAt = new Date(Date.now() + nextDelaySec * 1000).toISOString();
      const newAttempts = item.attempts + 1;
      const newStatus = newAttempts >= 5 ? 'failed' : 'pending';

      // Failure Fencing Update: status='processing' and locked_by=workerId
      await this.supabase.client
        .from('storage_cleanup_outbox')
        .update({
          status: newStatus,
          attempts: newAttempts,
          next_attempt_at: nextAttemptAt,
          last_error: err.message || 'Lỗi dọn dẹp storage',
          locked_by: null,
          locked_at: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('status', 'processing')
        .eq('locked_by', this.workerId);

      return false;
    }
  }
}
