import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PresenceStatus } from '../../shared/dto/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';
import type {
  ConversationParticipantProfile,
  ConversationResponseDto,
} from './dto/conversation-response.dto';

interface RawConversationRow {
  id: string;
  type: 'dm' | 'group';
  name: string | null;
  icon_url: string | null;
  owner_id: string | null;
  dm_key: string | null;
  created_at: string;
}

interface RawProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status_message: string | null;
  manual_presence: string;
}

const PRESENCE_VALUES = new Set<PresenceStatus>([
  'online',
  'idle',
  'dnd',
  'offline',
]);

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Tìm hoặc tạo cuộc trò chuyện trực tiếp (DM) giữa 2 người dùng.
   * Sử dụng RPC canonical `get_or_create_dm_conversation` với transaction advisory lock,
   * kiểm tra quan hệ chặn 2 chiều và đảm bảo đủ 2 participants một cách nguyên tử.
   */
  async getOrCreateDm(
    userId: string,
    recipientId: string,
  ): Promise<ConversationResponseDto> {
    if (userId === recipientId) {
      throw new BadRequestException(
        'Không thể tạo cuộc trò chuyện trực tiếp với chính mình.',
      );
    }

    const { data: convData, error: rpcErr } = await this.supabase.client.rpc(
      'get_or_create_dm_conversation',
      {
        p_user_id: userId,
        p_recipient_id: recipientId,
      },
    );

    if (rpcErr) {
      if (rpcErr.code === '42501' || rpcErr.message?.includes('chặn')) {
        throw new ForbiddenException(
          'Không thể nhắn tin trực tiếp với người dùng này do đã bị chặn.',
        );
      }
      if (rpcErr.code === 'P0002') {
        throw new NotFoundException('Không tìm thấy người dùng nhận.');
      }
      if (rpcErr.code === '22023') {
        throw new BadRequestException(rpcErr.message || 'Yêu cầu không hợp lệ.');
      }
      this.logger.error('Lỗi gọi RPC get_or_create_dm_conversation:', rpcErr);
      throw new InternalServerErrorException('Lỗi tạo cuộc trò chuyện.');
    }

    if (!convData) {
      throw new InternalServerErrorException('Lỗi tạo cuộc trò chuyện.');
    }

    const recipient = await this.getParticipantProfile(recipientId);

    // Trạng thái duyệt: nếu HAI người chưa là bạn bè và cuộc trò chuyện còn mới
    // (chưa có tin nhắn) thì đây là "message request" — phía NGƯỜI NHẬN để pending,
    // người khởi tạo (userId) vẫn accepted. Nếu đã là bạn thì đảm bảo cả hai accepted.
    const isFriend = await this.areFriends(userId, recipientId);
    try {
      if (isFriend) {
        await this.supabase.client
          .from('conversation_participants')
          .update({ request_state: 'accepted' })
          .eq('conversation_id', convData.id);
      } else {
        const { count } = await this.supabase.client
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', convData.id);
        if (!count) {
          await this.supabase.client
            .from('conversation_participants')
            .update({ request_state: 'pending' })
            .eq('conversation_id', convData.id)
            .eq('user_id', recipientId);
        }
      }
    } catch {
      // Bỏ qua nếu cột request_state chưa được tạo trên DB
    }

    return {
      id: convData.id,
      type: convData.type,
      name: convData.name,
      iconUrl: convData.icon_url,
      recipient,
      unreadCount: 0,
      createdAt: convData.created_at,
      requestState: 'accepted',
      isFriend,
    };
  }

  /** Hai user có phải bạn bè (accepted) của nhau không. */
  private async areFriends(a: string, b: string): Promise<boolean> {
    const { data } = await this.supabase.client
      .from('friendships')
      .select('status')
      .eq('status', 'accepted')
      .or(
        `and(user_a_id.eq.${a},user_b_id.eq.${b}),and(user_a_id.eq.${b},user_b_id.eq.${a})`,
      )
      .limit(1);
    return !!(data && data.length > 0);
  }

  /**
   * Người nhận CHẤP NHẬN một message request — mở khoá nhắn tin/gọi.
   */
  async acceptRequest(userId: string, conversationId: string): Promise<void> {
    const isMember = await this.verifyMembership(userId, conversationId);
    if (!isMember) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }
    await this.supabase.client
      .from('conversation_participants')
      .update({ request_state: 'accepted' })
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);
  }

  /**
   * Người nhận TỪ CHỐI — xoá hẳn cuộc trò chuyện (theo lựa chọn sản phẩm).
   * Trả về danh sách participant để tầng gọi phát realtime `conversation:deleted`.
   */
  async declineRequest(
    userId: string,
    conversationId: string,
  ): Promise<{ participantIds: string[] }> {
    const isMember = await this.verifyMembership(userId, conversationId);
    if (!isMember) {
      throw new ForbiddenException('Bạn không thuộc cuộc trò chuyện này.');
    }
    const participantIds = await this.getParticipantIds(conversationId);
    await this.supabase.client
      .from('conversations')
      .delete()
      .eq('id', conversationId);

    // Báo realtime cho cả hai phía để xoá khỏi danh sách ngay.
    const other = participantIds.find((id) => id !== userId) ?? userId;
    this.eventEmitter.emit(CHAT_EVENTS.CONVERSATION_DELETED, {
      conversationId,
      userId,
      friendId: other,
    });

    return { participantIds };
  }

  /** Trạng thái duyệt của một user trong một DM (mặc định 'accepted'). */
  async getRequestState(
    userId: string,
    conversationId: string,
  ): Promise<'pending' | 'accepted'> {
    try {
      const { data, error } = await this.supabase.client
        .from('conversation_participants')
        .select('request_state')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        return 'accepted';
      }
      return (data?.request_state as 'pending' | 'accepted') ?? 'accepted';
    } catch {
      return 'accepted';
    }
  }

  /**
   * Lấy danh sách tất cả các cuộc trò chuyện của user hiện tại.
   */
  async listConversations(userId: string): Promise<ConversationResponseDto[]> {
    // 1. Lấy danh sách conversation_id mà user tham gia
    const { data: myParts, error: partErr } = await this.supabase.client
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', userId);

    if (partErr || !myParts || myParts.length === 0) {
      return [];
    }

    const convIds = myParts.map((p) => p.conversation_id as string);

    // 2. Lấy thông tin chi tiết các conversations
    const { data: convs, error: convErr } = await this.supabase.client
      .from('conversations')
      .select('id, type, name, icon_url, owner_id, dm_key, created_at')
      .in('id', convIds)
      .order('created_at', { ascending: false });

    if (convErr || !convs) {
      this.logger.error('Lỗi lấy danh sách conversations:', convErr);
      throw new InternalServerErrorException('Lỗi tải danh sách cuộc trò chuyện.');
    }

    // 3. Lấy tất cả participants của các conversations này để tìm người đối thoại (nếu là DM)
    let allParts: Array<{ conversation_id: string; user_id: string; request_state?: string }> = [];
    const { data: allPartsData, error: allPartsErr } = await this.supabase.client
      .from('conversation_participants')
      .select('conversation_id, user_id, request_state')
      .in('conversation_id', convIds);

    if (allPartsErr) {
      if (allPartsErr.code === '42703') {
        // Fallback an toàn khi cột request_state chưa được tạo trên CSDL
        const { data: fallbackParts } = await this.supabase.client
          .from('conversation_participants')
          .select('conversation_id, user_id')
          .in('conversation_id', convIds);
        allParts = (fallbackParts as any) ?? [];
      } else {
        this.logger.error('Lỗi lấy all conversation_participants:', allPartsErr);
      }
    } else {
      allParts = (allPartsData as any) ?? [];
    }

    const otherUserIds = new Set<string>();
    const convToOtherUser = new Map<string, string>();
    // Trạng thái duyệt của CHÍNH user trong từng DM (để tách "Người lạ" vs DM thường).
    const myStateMap = new Map<string, 'pending' | 'accepted'>();

    for (const p of allParts ?? []) {
      if (p.user_id === userId) {
        myStateMap.set(
          p.conversation_id as string,
          (p.request_state as 'pending' | 'accepted') ?? 'accepted',
        );
      } else {
        otherUserIds.add(p.user_id as string);
        convToOtherUser.set(p.conversation_id as string, p.user_id as string);
      }
    }

    // 4. Lấy profiles của các user đối thoại
    const profileMap = new Map<string, ConversationParticipantProfile>();
    if (otherUserIds.size > 0) {
      const { data: profiles } = await this.supabase.client
        .from('profiles')
        .select('id, username, display_name, avatar_url, status_message, manual_presence')
        .in('id', Array.from(otherUserIds));

      for (const raw of (profiles ?? []) as RawProfileRow[]) {
        profileMap.set(raw.id, {
          id: raw.id,
          username: raw.username,
          displayName: raw.display_name ?? raw.username,
          avatarUrl: raw.avatar_url,
          statusMessage: raw.status_message,
          presence: PRESENCE_VALUES.has(raw.manual_presence as PresenceStatus)
            ? (raw.manual_presence as PresenceStatus)
            : 'offline',
        });
      }
    }

    // 5. Lấy read_states để tính unread
    const { data: readStates } = await this.supabase.client
      .from('read_states')
      .select('conversation_id, mention_count')
      .eq('user_id', userId)
      .in('conversation_id', convIds);

    const unreadMap = new Map<string, number>();
    for (const rs of readStates ?? []) {
      unreadMap.set(rs.conversation_id as string, rs.mention_count ?? 0);
    }

    // 6. Lấy danh sách bạn bè đã chấp nhận (status = 'accepted') để đảm bảo chỉ trả về DM với bạn bè hiện tại
    const { data: friendships } = await this.supabase.client
      .from('friendships')
      .select('user_a_id, user_b_id, status')
      .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
      .eq('status', 'accepted');

    const acceptedFriendIds = new Set<string>();
    for (const f of friendships ?? []) {
      const friendId = f.user_a_id === userId ? f.user_b_id : f.user_a_id;
      acceptedFriendIds.add(friendId as string);
    }

    const orphanConvIds: string[] = [];
    const result: ConversationResponseDto[] = [];

    for (const conv of convs as RawConversationRow[]) {
      const otherId = convToOtherUser.get(conv.id);

      // DM phải còn người đối thoại; nếu profile người kia biến mất hẳn thì mới là
      // mồ côi thật. KHÔNG còn xoá DM chỉ vì chưa kết bạn — DM người-lạ vẫn giữ để
      // hiện ở mục "Người lạ" (message request) / Tin nhắn trực tiếp.
      if (conv.type === 'dm' && (!otherId || !profileMap.has(otherId))) {
        orphanConvIds.push(conv.id);
        continue;
      }

      const recipient = otherId ? profileMap.get(otherId) : undefined;
      result.push({
        id: conv.id,
        type: conv.type,
        name: conv.name,
        iconUrl: conv.icon_url,
        recipient,
        unreadCount: unreadMap.get(conv.id) ?? 0,
        createdAt: conv.created_at,
        requestState: conv.type === 'dm' ? (myStateMap.get(conv.id) ?? 'accepted') : 'accepted',
        isFriend: otherId ? acceptedFriendIds.has(otherId) : false,
      });
    }

    // Chỉ dọn DM mồ côi THẬT (mất người đối thoại), không đụng DM người-lạ.
    if (orphanConvIds.length > 0) {
      void this.supabase.client
        .from('conversations')
        .delete()
        .in('id', orphanConvIds);
    }

    return result;
  }

  /**
   * Lấy thông tin 1 cuộc trò chuyện và kiểm tra quyền thành viên.
   */
  async getConversationById(
    userId: string,
    conversationId: string,
  ): Promise<ConversationResponseDto> {
    const isMember = await this.verifyMembership(userId, conversationId);
    if (!isMember) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của cuộc trò chuyện này.',
      );
    }

    const { data: conv, error } = await this.supabase.client
      .from('conversations')
      .select('id, type, name, icon_url, owner_id, dm_key, created_at')
      .eq('id', conversationId)
      .maybeSingle();

    if (error || !conv) {
      throw new NotFoundException('Không tìm thấy cuộc trò chuyện.');
    }

    const rawConv = conv as RawConversationRow;

    // Tìm người bên kia nếu là DM
    let recipient: ConversationParticipantProfile | undefined;
    if (rawConv.type === 'dm') {
      const { data: parts } = await this.supabase.client
        .from('conversation_participants')
        .select('user_id')
        .eq('conversation_id', conversationId);

      const otherPart = parts?.find((p) => p.user_id !== userId);
      if (otherPart) {
        recipient = await this.getParticipantProfile(otherPart.user_id as string);
      }
    }

    const requestState =
      rawConv.type === 'dm'
        ? await this.getRequestState(userId, conversationId)
        : 'accepted';
    const isFriend =
      rawConv.type === 'dm' && recipient
        ? await this.areFriends(userId, recipient.id)
        : false;

    return {
      id: rawConv.id,
      type: rawConv.type,
      name: rawConv.name,
      iconUrl: rawConv.icon_url,
      recipient,
      unreadCount: 0,
      createdAt: rawConv.created_at,
      requestState,
      isFriend,
    };
  }

  /**
   * Kiểm tra xem user có phải là thành viên của conversation hay không.
   */
  async verifyMembership(
    userId: string,
    conversationId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.client
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) {
      return false;
    }
    return true;
  }

  /**
   * Lấy danh sách user_id của tất cả thành viên trong conversation.
   * Dùng cho ChatGateway để emit user-room notification.
   */
  async getParticipantIds(conversationId: string): Promise<string[]> {
    const { data, error } = await this.supabase.client
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', conversationId);

    if (error || !data) return [];
    return data.map((p) => p.user_id as string);
  }

  async getDmPeerUserIds(userId: string): Promise<string[]> {
    try {
      const { data: myParts, error: myErr } = await this.supabase.client
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', userId);

      if (myErr || !myParts || myParts.length === 0) return [];

      const convIds = myParts.map((p) => p.conversation_id as string);
      const { data: allParts, error: allErr } = await this.supabase.client
        .from('conversation_participants')
        .select('user_id')
        .in('conversation_id', convIds)
        .neq('user_id', userId);

      if (allErr || !allParts) return [];

      const peerIds = new Set<string>();
      for (const p of allParts) {
        if (p.user_id) {
          peerIds.add(p.user_id as string);
        }
      }
      return Array.from(peerIds);
    } catch {
      return [];
    }
  }

  private async getParticipantProfile(
    profileId: string,
  ): Promise<ConversationParticipantProfile> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url, status_message, manual_presence')
      .eq('id', profileId)
      .maybeSingle();

    if (error || !data) {
      return {
        id: profileId,
        username: 'unknown',
        displayName: 'Người dùng',
        avatarUrl: null,
        statusMessage: null,
        presence: 'offline',
      };
    }

    const raw = data as RawProfileRow;
    return {
      id: raw.id,
      username: raw.username,
      displayName: raw.display_name ?? raw.username,
      avatarUrl: raw.avatar_url,
      statusMessage: raw.status_message,
      presence: PRESENCE_VALUES.has(raw.manual_presence as PresenceStatus)
        ? (raw.manual_presence as PresenceStatus)
        : 'offline',
    };
  }
}
