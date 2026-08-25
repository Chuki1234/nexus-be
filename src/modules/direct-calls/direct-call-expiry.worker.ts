import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ChatGateway } from '../realtime/chat.gateway';
import { Room } from '../../shared/socket-events';
import { DirectCallDto } from '../../shared/dto/direct-calls.dto';

interface RawExpiredCallRow {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  initial_mode: 'audio' | 'video';
  status: string;
  livekit_room_name: string;
  initiated_at: string;
  expires_at: string;
  answered_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: any;
  version: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class DirectCallExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DirectCallExpiryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly chatGateway: ChatGateway,
  ) {}

  onModuleInit() {
    this.startWorker();
  }

  onModuleDestroy() {
    this.stopWorker();
  }

  startWorker() {
    if (this.timer) return;
    this.logger.log('DirectCallExpiryWorker đã khởi động (chu kỳ 5s).');
    this.timer = setInterval(() => {
      this.processExpiredCalls().catch((err) => {
        this.logger.error(`Lỗi không mong muốn trong DirectCallExpiryWorker: ${err?.message}`);
      });
    }, 5000);
  }

  stopWorker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Quét và chuyển trạng thái các cuộc gọi ringing đã hết hạn sang 'missed'
   * Multi-instance safe nhờ FOR UPDATE SKIP LOCKED trong stored procedure.
   */
  async processExpiredCalls(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const { data, error } = await this.supabase.client.rpc(
        'expire_ringing_direct_calls',
      );

      if (error) {
        this.logger.error(`Lỗi expire_ringing_direct_calls RPC: ${error.message}`);
        return 0;
      }

      const expiredList: RawExpiredCallRow[] = Array.isArray(data) ? data : [];
      if (expiredList.length === 0) return 0;

      this.logger.log(
        `Đã xử lý ${expiredList.length} cuộc gọi hết hạn ringing sang missed.`,
      );

      for (const raw of expiredList) {
        const callDto = await this.populateProfiles(raw);
        this.chatGateway.server
          .to(Room.user(callDto.caller.id))
          .emit('direct-call:missed', callDto);
        this.chatGateway.server
          .to(Room.user(callDto.callee.id))
          .emit('direct-call:missed', callDto);
      }

      return expiredList.length;
    } catch (err: any) {
      this.logger.error(`Lỗi processExpiredCalls: ${err?.message}`);
      return 0;
    } finally {
      this.isProcessing = false;
    }
  }

  private async populateProfiles(raw: RawExpiredCallRow): Promise<DirectCallDto> {
    const { data: profiles } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', [raw.caller_id, raw.callee_id]);

    const profileMap = new Map<string, any>();
    if (profiles) {
      for (const p of profiles) {
        profileMap.set(p.id, p);
      }
    }

    const caller = profileMap.get(raw.caller_id) || {
      id: raw.caller_id,
      username: 'User',
      display_name: null,
      avatar_url: null,
    };
    const callee = profileMap.get(raw.callee_id) || {
      id: raw.callee_id,
      username: 'User',
      display_name: null,
      avatar_url: null,
    };

    return {
      id: raw.id,
      conversationId: raw.conversation_id,
      caller: {
        id: caller.id,
        username: caller.username,
        displayName: caller.display_name,
        avatarUrl: caller.avatar_url,
      },
      callee: {
        id: callee.id,
        username: callee.username,
        displayName: callee.display_name,
        avatarUrl: callee.avatar_url,
      },
      initialMode: raw.initial_mode,
      status: 'missed',
      livekitRoomName: raw.livekit_room_name,
      initiatedAt: raw.initiated_at,
      expiresAt: raw.expires_at,
      answeredAt: raw.answered_at,
      connectedAt: raw.connected_at,
      endedAt: raw.ended_at,
      endedBy: raw.ended_by,
      endReason: raw.end_reason || 'no_answer',
      version: raw.version,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }
}
