import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { SupabaseService } from '../../infra/supabase/supabase.service';

interface OutboxItem {
  id: string;
  call_id: string;
  room_name: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

@Injectable()
export class DirectCallCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DirectCallCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private roomService: RoomServiceClient | null = null;
  private isProcessing = false;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {
    const livekitUrl =
      this.config.get<string>('LIVEKIT_URL') || process.env['LIVEKIT_URL'];
    const apiKey =
      this.config.get<string>('LIVEKIT_API_KEY') ||
      process.env['LIVEKIT_API_KEY'];
    const apiSecret =
      this.config.get<string>('LIVEKIT_API_SECRET') ||
      process.env['LIVEKIT_API_SECRET'];

    if (livekitUrl && apiKey && apiSecret) {
      this.roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    }
  }

  onModuleInit() {
    this.startWorker();
  }

  onModuleDestroy() {
    this.stopWorker();
  }

  startWorker() {
    if (this.timer) return;
    this.logger.log('DirectCallCleanupWorker đã khởi động (chu kỳ 10s).');
    this.timer = setInterval(() => {
      this.processOutbox().catch((err) => {
        this.logger.error(`Lỗi trong DirectCallCleanupWorker: ${err?.message}`);
      });
    }, 10000);
  }

  stopWorker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Xử lý các job dọn dẹp phòng LiveKit còn tồn trong outbox table
   */
  async processOutbox(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      // 1. Lấy danh sách job cần xử lý
      const { data: jobs, error } = await this.supabase.client
        .from('direct_call_room_cleanup_outbox')
        .select('*')
        .in('status', ['pending', 'processing'])
        .lte('next_attempt_at', new Date().toISOString())
        .order('next_attempt_at', { ascending: true })
        .limit(10);

      if (error) {
        this.logger.error(`Lỗi đọc cleanup outbox: ${error.message}`);
        return 0;
      }

      if (!jobs || jobs.length === 0) return 0;

      let processedCount = 0;

      for (const rawJob of jobs) {
        const job = rawJob as OutboxItem;
        await this.handleJob(job);
        processedCount++;
      }

      return processedCount;
    } catch (err: any) {
      this.logger.error(`Lỗi processOutbox: ${err?.message}`);
      return 0;
    } finally {
      this.isProcessing = false;
    }
  }

  private async handleJob(job: OutboxItem): Promise<void> {
    const newAttempts = job.attempts + 1;

    try {
      if (this.roomService) {
        try {
          await this.roomService.deleteRoom(job.room_name);
          this.logger.log(`Đã đóng phòng LiveKit: ${job.room_name}`);
        } catch (lkError: any) {
          const errMsg = lkError?.message || String(lkError);
          // Nếu phòng không tồn tại (404/not found) thì coi như đã thành công
          if (
            errMsg.includes('not found') ||
            errMsg.includes('404') ||
            errMsg.includes('could not find room')
          ) {
            this.logger.debug(
              `Phòng LiveKit ${job.room_name} đã không còn tồn tại -> Completed.`,
            );
          } else {
            throw lkError;
          }
        }
      }

      // Đánh dấu thành công
      await this.supabase.client
        .from('direct_call_room_cleanup_outbox')
        .update({
          status: 'completed',
          attempts: newAttempts,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.logger.warn(
        `Lỗi dọn dẹp phòng ${job.room_name} (lần ${newAttempts}): ${errMsg}`,
      );

      const isExhausted = newAttempts >= job.max_attempts;
      const delaySeconds = Math.min(Math.pow(2, newAttempts) * 5, 300);
      const nextAttemptAt = new Date(
        Date.now() + delaySeconds * 1000,
      ).toISOString();

      await this.supabase.client
        .from('direct_call_room_cleanup_outbox')
        .update({
          status: isExhausted ? 'failed' : 'pending',
          attempts: newAttempts,
          next_attempt_at: nextAttemptAt,
          last_error: errMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }
  }
}
