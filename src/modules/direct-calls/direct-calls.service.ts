import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookReceiver } from 'livekit-server-sdk';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ChatGateway } from '../realtime/chat.gateway';
import { Room } from '../../shared/socket-events';
import {
  AnswerDirectCallRequestDto,
  AnswerDirectCallResponseDto,
  CreateDirectCallRequestDto,
  DirectCallDto,
  DirectCallTokenRequestDto,
  DirectCallTokenResponseDto,
  EndDirectCallRequestDto,
  GetActiveDirectCallResponseDto,
} from '../../shared/dto/direct-calls.dto';
import { DirectCallTokenService } from './direct-call-token.service';

interface RawCallRow {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  caller_session_id: string;
  answered_session_id: string | null;
  initial_mode: 'audio' | 'video';
  status:
    | 'ringing'
    | 'accepted'
    | 'declined'
    | 'cancelled'
    | 'missed'
    | 'ended'
    | 'failed';
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
  should_join_media?: boolean;
}

interface ProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

@Injectable()
export class DirectCallsService {
  private readonly logger = new Logger(DirectCallsService.name);
  private webhookReceiver: WebhookReceiver | null = null;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly chatGateway: ChatGateway,
    private readonly tokenService: DirectCallTokenService,
    private readonly config: ConfigService,
  ) {
    const apiKey =
      this.config.get<string>('LIVEKIT_API_KEY') ||
      process.env['LIVEKIT_API_KEY'];
    const apiSecret =
      this.config.get<string>('LIVEKIT_API_SECRET') ||
      process.env['LIVEKIT_API_SECRET'];
    if (apiKey && apiSecret) {
      this.webhookReceiver = new WebhookReceiver(apiKey, apiSecret);
    }
  }

  /**
   * Helper: Điền thông tin profile của Caller và Callee vào Call Record
   */
  private async populateProfiles(rawCall: RawCallRow): Promise<DirectCallDto> {
    const { data: profiles, error } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', [rawCall.caller_id, rawCall.callee_id]);

    if (error) {
      this.logger.error(`Lỗi truy vấn profiles: ${error.message}`);
    }

    const profileMap = new Map<string, ProfileRow>();
    if (profiles) {
      for (const p of profiles) {
        profileMap.set(p.id, p);
      }
    }

    const callerProfile = profileMap.get(rawCall.caller_id) || {
      id: rawCall.caller_id,
      username: 'User',
      display_name: null,
      avatar_url: null,
    };

    const calleeProfile = profileMap.get(rawCall.callee_id) || {
      id: rawCall.callee_id,
      username: 'User',
      display_name: null,
      avatar_url: null,
    };

    return {
      id: rawCall.id,
      conversationId: rawCall.conversation_id,
      caller: {
        id: callerProfile.id,
        username: callerProfile.username,
        displayName: callerProfile.display_name,
        avatarUrl: callerProfile.avatar_url,
      },
      callee: {
        id: calleeProfile.id,
        username: calleeProfile.username,
        displayName: calleeProfile.display_name,
        avatarUrl: calleeProfile.avatar_url,
      },
      initialMode: rawCall.initial_mode,
      status: rawCall.status,
      livekitRoomName: rawCall.livekit_room_name,
      initiatedAt: rawCall.initiated_at,
      expiresAt: rawCall.expires_at,
      answeredAt: rawCall.answered_at,
      connectedAt: rawCall.connected_at,
      endedAt: rawCall.ended_at,
      endedBy: rawCall.ended_by,
      endReason: rawCall.end_reason,
      version: rawCall.version,
      createdAt: rawCall.created_at,
      updatedAt: rawCall.updated_at,
    };
  }

  /**
   * Bắt đầu cuộc gọi 1-1
   */
  async startCall(
    callerId: string,
    dto: CreateDirectCallRequestDto,
  ): Promise<DirectCallDto> {
    const { data, error } = await this.supabase.client.rpc('start_direct_call', {
      p_conversation_id: dto.conversationId,
      p_caller_id: callerId,
      p_caller_session_id: dto.clientSessionId,
      p_initial_mode: dto.initialMode,
      p_ring_timeout_seconds: 45,
    });

    if (error) {
      this.logger.warn(`start_direct_call lỗi: ${error.message} (code: ${error.code})`);
      if (error.message?.includes('BUSY') || error.code === '23505') {
        throw new ConflictException('Người dùng hiện đang trong một cuộc gọi khác.');
      }
      if (error.message?.includes('kết bạn') || error.message?.includes('chặn')) {
        throw new ForbiddenException(error.message);
      }
      throw new BadRequestException(error.message || 'Không thể tạo cuộc gọi.');
    }

    const rawCall: RawCallRow = Array.isArray(data) ? data[0] : data;
    if (!rawCall) {
      throw new InternalServerErrorException('Lỗi máy chủ: không nhận được dữ liệu cuộc gọi.');
    }

    const callDto = await this.populateProfiles(rawCall);

    // Phát socket events
    this.chatGateway.server
      .to(Room.user(callDto.callee.id))
      .emit('direct-call:incoming', callDto);
    this.chatGateway.server
      .to(Room.user(callDto.caller.id))
      .emit('direct-call:ringing', callDto);

    return callDto;
  }

  /**
   * Chấp nhận cuộc gọi (Winning session gets shouldJoinMedia = true)
   */
  async answerCall(
    calleeId: string,
    callId: string,
    dto: AnswerDirectCallRequestDto,
  ): Promise<AnswerDirectCallResponseDto> {
    const { data, error } = await this.supabase.client.rpc('answer_direct_call', {
      p_call_id: callId,
      p_user_id: calleeId,
      p_client_session_id: dto.clientSessionId,
    });

    if (error) {
      this.logger.warn(`answer_direct_call lỗi: ${error.message}`);
      if (error.message?.includes('EXPIRED')) {
        throw new BadRequestException('Cuộc gọi đã hết hạn hoặc đã bị hủy.');
      }
      throw new BadRequestException(error.message || 'Không thể chấp nhận cuộc gọi.');
    }

    const rawCall: RawCallRow = Array.isArray(data) ? data[0] : data;
    if (!rawCall) {
      throw new NotFoundException('Không tìm thấy cuộc gọi.');
    }

    const callDto = await this.populateProfiles(rawCall);
    const shouldJoinMedia = Boolean(rawCall.should_join_media);

    // Emit accepted to both caller and callee
    this.chatGateway.server
      .to(Room.user(callDto.caller.id))
      .emit('direct-call:accepted', callDto);
    this.chatGateway.server
      .to(Room.user(callDto.callee.id))
      .emit('direct-call:accepted', callDto);

    return {
      call: callDto,
      shouldJoinMedia,
    };
  }

  /**
   * Từ chối cuộc gọi đang ringing
   */
  async declineCall(calleeId: string, callId: string): Promise<DirectCallDto> {
    const { data, error } = await this.supabase.client.rpc('decline_direct_call', {
      p_call_id: callId,
      p_user_id: calleeId,
    });

    if (error) {
      this.logger.warn(`decline_direct_call lỗi: ${error.message}`);
      throw new BadRequestException(error.message || 'Không thể từ chối cuộc gọi.');
    }

    const rawCall: RawCallRow = Array.isArray(data) ? data[0] : data;
    if (!rawCall) {
      throw new NotFoundException('Không tìm thấy cuộc gọi.');
    }

    const callDto = await this.populateProfiles(rawCall);

    this.chatGateway.server
      .to(Room.user(callDto.caller.id))
      .emit('direct-call:declined', callDto);
    this.chatGateway.server
      .to(Room.user(callDto.callee.id))
      .emit('direct-call:declined', callDto);

    return callDto;
  }

  /**
   * Hủy cuộc gọi đang ringing (Caller)
   */
  async cancelCall(callerId: string, callId: string): Promise<DirectCallDto> {
    const { data, error } = await this.supabase.client.rpc('cancel_direct_call', {
      p_call_id: callId,
      p_user_id: callerId,
    });

    if (error) {
      this.logger.warn(`cancel_direct_call lỗi: ${error.message}`);
      throw new BadRequestException(error.message || 'Không thể hủy cuộc gọi.');
    }

    const rawCall: RawCallRow = Array.isArray(data) ? data[0] : data;
    if (!rawCall) {
      throw new NotFoundException('Không tìm thấy cuộc gọi.');
    }

    const callDto = await this.populateProfiles(rawCall);

    this.chatGateway.server
      .to(Room.user(callDto.caller.id))
      .emit('direct-call:cancelled', callDto);
    this.chatGateway.server
      .to(Room.user(callDto.callee.id))
      .emit('direct-call:cancelled', callDto);

    return callDto;
  }

  /**
   * Kết thúc cuộc gọi đang accepted
   */
  async endCall(
    userId: string,
    callId: string,
    dto: EndDirectCallRequestDto,
  ): Promise<DirectCallDto> {
    const { data, error } = await this.supabase.client.rpc('end_direct_call', {
      p_call_id: callId,
      p_user_id: userId,
      p_end_reason: dto.reason || 'hangup',
    });

    if (error) {
      this.logger.warn(`end_direct_call lỗi: ${error.message}`);
      throw new BadRequestException(error.message || 'Không thể kết thúc cuộc gọi.');
    }

    const rawCall: RawCallRow = Array.isArray(data) ? data[0] : data;
    if (!rawCall) {
      throw new NotFoundException('Không tìm thấy cuộc gọi.');
    }

    const callDto = await this.populateProfiles(rawCall);

    this.chatGateway.server
      .to(Room.user(callDto.caller.id))
      .emit('direct-call:ended', callDto);
    this.chatGateway.server
      .to(Room.user(callDto.callee.id))
      .emit('direct-call:ended', callDto);

    return callDto;
  }

  /**
   * Lấy cuộc gọi active của user (phục vụ F5 / Reconnect)
   */
  async getActiveCall(
    userId: string,
    clientSessionId?: string,
  ): Promise<GetActiveDirectCallResponseDto> {
    const { data, error } = await this.supabase.client
      .from('direct_calls')
      .select('*')
      .or(`caller_id.eq.${userId},callee_id.eq.${userId}`)
      .in('status', ['ringing', 'accepted'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.error(`getActiveCall lỗi: ${error.message}`);
      throw new InternalServerErrorException('Không lấy được cuộc gọi hiện tại.');
    }

    if (!data) {
      return { call: null };
    }

    const rawCall: RawCallRow = data;
    const role: 'caller' | 'callee' =
      rawCall.caller_id === userId ? 'caller' : 'callee';

    const isMediaOwner =
      Boolean(clientSessionId) &&
      ((role === 'caller' && rawCall.caller_session_id === clientSessionId) ||
        (role === 'callee' && rawCall.answered_session_id === clientSessionId));

    const callDto = await this.populateProfiles(rawCall);

    return {
      call: callDto,
      role,
      isMediaOwner,
    };
  }

  /**
   * Cấp LiveKit token cho phiên cuộc gọi
   */
  async getToken(
    userId: string,
    callId: string,
    dto: DirectCallTokenRequestDto,
  ): Promise<DirectCallTokenResponseDto> {
    const { data: call, error } = await this.supabase.client
      .from('direct_calls')
      .select('*')
      .eq('id', callId)
      .maybeSingle();

    if (error || !call) {
      throw new NotFoundException('Không tìm thấy cuộc gọi.');
    }

    if (call.status !== 'ringing' && call.status !== 'accepted') {
      throw new BadRequestException('Cuộc gọi không ở trạng thái sẵn sàng để lấy token.');
    }

    const isCallerOwner =
      call.caller_id === userId && call.caller_session_id === dto.clientSessionId;
    const isCalleeOwner =
      call.callee_id === userId && call.answered_session_id === dto.clientSessionId;

    if (!isCallerOwner && !isCalleeOwner) {
      this.logger.warn(
        `Từ chối cấp token: userId=${userId}, sessionId=${dto.clientSessionId} không phải media owner của callId=${callId}`,
      );
      throw new ForbiddenException('Thiết bị hoặc tab này không có quyền tham gia media.');
    }

    const { data: profile } = await this.supabase.client
      .from('profiles')
      .select('username, display_name')
      .eq('id', userId)
      .maybeSingle();

    return this.tokenService.generateToken(
      callId,
      userId,
      profile?.display_name,
      profile?.username,
    );
  }

  /**
   * Xử lý LiveKit Webhook (participant_joined -> mark_direct_call_connected)
   */
  async handleWebhook(body: string | Buffer, authHeader?: string): Promise<void> {
    if (!this.webhookReceiver) {
      this.logger.warn('LiveKit WebhookReceiver chưa được cấu hình credentials.');
      return;
    }

    if (!authHeader) {
      this.logger.warn('LiveKit Webhook bị từ chối: Thiếu Authorization header.');
      throw new BadRequestException('Missing Authorization header for webhook verification.');
    }

    try {
      const isBuf = Buffer.isBuffer(body);
      const rawString = isBuf
        ? (body as Buffer).toString('utf8')
        : typeof body === 'string'
          ? body
          : body
            ? JSON.stringify(body)
            : '';

      this.logger.debug(
        `Webhook payload type: ${typeof body}, isBuffer: ${isBuf}, length: ${rawString.length}`,
      );

      const event = await this.webhookReceiver.receive(rawString, authHeader);

      if (event.event === 'participant_joined' && event.room) {
        const roomName = event.room.name;
        if (roomName.startsWith('nexus:dm-call:')) {
          const callId = roomName.replace('nexus:dm-call:', '');
          const { data, error } = await this.supabase.client.rpc(
            'mark_direct_call_connected',
            { p_call_id: callId },
          );

          if (!error && data) {
            const rawCall: any = Array.isArray(data) ? data[0] : data;
            // Chỉ phát socket event khi transition trạng thái từ null -> connected_at thực sự thành công
            if (rawCall?.did_transition && rawCall?.connected_at) {
              this.chatGateway.server
                .to(Room.user(rawCall.caller_id))
                .emit('direct-call:connected', {
                  callId: rawCall.id,
                  connectedAt: rawCall.connected_at,
                });
              this.chatGateway.server
                .to(Room.user(rawCall.callee_id))
                .emit('direct-call:connected', {
                  callId: rawCall.id,
                  connectedAt: rawCall.connected_at,
                });
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Xử lý LiveKit webhook thất bại: ${err?.message}`);
      throw new BadRequestException(`LiveKit webhook verification failed: ${err?.message}`);
    }
  }

  /**
   * Lấy lịch sử cuộc gọi trong DM
   */
  async getCallHistory(
    userId: string,
    conversationId: string,
  ): Promise<DirectCallDto[]> {
    const { data, error } = await this.supabase.client
      .from('direct_calls')
      .select('*')
      .eq('conversation_id', conversationId)
      .or(`caller_id.eq.${userId},callee_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      this.logger.error(`getCallHistory lỗi: ${error.message}`);
      throw new InternalServerErrorException('Không lấy được lịch sử cuộc gọi.');
    }

    if (!data || data.length === 0) {
      return [];
    }

    const results: DirectCallDto[] = [];
    for (const row of data) {
      results.push(await this.populateProfiles(row));
    }
    return results;
  }
}
