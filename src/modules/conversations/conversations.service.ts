import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PresenceStatus } from '../../shared/dto/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
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

  constructor(private readonly supabase: SupabaseService) {}

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

    return {
      id: convData.id,
      type: convData.type,
      name: convData.name,
      iconUrl: convData.icon_url,
      recipient,
      unreadCount: 0,
      createdAt: convData.created_at,
    };
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
    const { data: allParts, error: allPartsErr } = await this.supabase.client
      .from('conversation_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', convIds);

    if (allPartsErr) {
      this.logger.error('Lỗi lấy all conversation_participants:', allPartsErr);
    }

    const otherUserIds = new Set<string>();
    const convToOtherUser = new Map<string, string>();

    for (const p of allParts ?? []) {
      if (p.user_id !== userId) {
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

      // Nếu là cuộc trò chuyện DM trực tiếp mà không còn quan hệ bạn bè accepted -> loại bỏ
      if (conv.type === 'dm') {
        if (!otherId || !acceptedFriendIds.has(otherId)) {
          orphanConvIds.push(conv.id);
          continue;
        }
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
      });
    }

    // Tự động dọn dẹp các DM mồ côi trong background nếu có
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

    return {
      id: rawConv.id,
      type: rawConv.type,
      name: rawConv.name,
      iconUrl: rawConv.icon_url,
      recipient,
      unreadCount: 0,
      createdAt: rawConv.created_at,
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
