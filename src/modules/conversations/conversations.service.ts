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
   * Tạo hoặc lấy cuộc trò chuyện trực tiếp 1-1 duy nhất giữa hai người.
   * Yêu cầu: Hai người phải đã kết bạn (friendship status = 'accepted').
   * Đảm bảo idempotent, chống race condition và tự động chữa lành conversation thiếu participants.
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

    // 1. Kiểm tra quan hệ bạn bè trong bảng `friendships`
    const [userA, userB] =
      userId < recipientId ? [userId, recipientId] : [recipientId, userId];

    const { data: friendship, error: friendErr } = await this.supabase.client
      .from('friendships')
      .select('status')
      .eq('user_a_id', userA)
      .eq('user_b_id', userB)
      .maybeSingle();

    if (friendErr) {
      this.logger.error('Lỗi kiểm tra bạn bè:', friendErr);
      throw new InternalServerErrorException('Lỗi kiểm tra quan hệ bạn bè.');
    }

    if (!friendship || friendship.status !== 'accepted') {
      throw new ForbiddenException(
        'Chỉ có thể nhắn tin trực tiếp với người đã kết bạn.',
      );
    }

    // 2. Tìm hoặc tạo conversation theo unique `dm_key`
    const dmKey = `${userA}:${userB}`;

    const { data: existingConv, error: convErr } = await this.supabase.client
      .from('conversations')
      .select('id, type, name, icon_url, owner_id, dm_key, created_at')
      .eq('dm_key', dmKey)
      .maybeSingle();

    if (convErr) {
      this.logger.error('Lỗi tìm conversation:', convErr);
      throw new InternalServerErrorException('Lỗi tìm cuộc trò chuyện.');
    }

    let conversation: RawConversationRow;

    if (existingConv) {
      conversation = existingConv as RawConversationRow;
    } else {
      // Tạo mới conversation
      const { data: newConv, error: createErr } = await this.supabase.client
        .from('conversations')
        .insert({
          type: 'dm',
          dm_key: dmKey,
          owner_id: userId,
        })
        .select('id, type, name, icon_url, owner_id, dm_key, created_at')
        .single();

      if (createErr) {
        // Xử lý race condition khi cả 2 user tạo đồng thời cùng một lúc (dm_key duplicate constraint)
        const isDuplicate =
          createErr.code === '23505' ||
          createErr.message?.includes('duplicate key') ||
          createErr.message?.includes('idx_conversations_dm_key');

        if (isDuplicate) {
          const { data: racedConv, error: raceErr } = await this.supabase.client
            .from('conversations')
            .select('id, type, name, icon_url, owner_id, dm_key, created_at')
            .eq('dm_key', dmKey)
            .single();

          if (raceErr || !racedConv) {
            this.logger.error('Lỗi lấy conversation sau race condition:', raceErr);
            throw new InternalServerErrorException('Lỗi tạo cuộc trò chuyện.');
          }
          conversation = racedConv as RawConversationRow;
        } else {
          this.logger.error('Lỗi tạo conversation:', createErr);
          throw new InternalServerErrorException('Lỗi tạo cuộc trò chuyện.');
        }
      } else if (!newConv) {
        throw new InternalServerErrorException('Lỗi tạo cuộc trò chuyện.');
      } else {
        conversation = newConv as RawConversationRow;
      }
    }

    // 3. Đảm bảo cả 2 participant luôn tồn tại trong conversation_participants
    // (kể cả conversation đã tồn tại trước đó nhưng bị thiếu participant mồ côi)
    const { error: partErr } = await this.supabase.client
      .from('conversation_participants')
      .upsert(
        [
          { conversation_id: conversation.id, user_id: userA },
          { conversation_id: conversation.id, user_id: userB },
        ],
        { onConflict: 'conversation_id,user_id', ignoreDuplicates: true },
      );

    if (partErr) {
      this.logger.error('Lỗi đảm bảo participants vào conversation:', partErr);
      throw new InternalServerErrorException(
        'Lỗi liên kết người tham gia cuộc trò chuyện.',
      );
    }

    // 4. Lấy thông tin profile người nhận
    const recipient = await this.getParticipantProfile(recipientId);

    return {
      id: conversation.id,
      type: conversation.type,
      name: conversation.name,
      iconUrl: conversation.icon_url,
      recipient,
      unreadCount: 0,
      createdAt: conversation.created_at,
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

    return (convs as RawConversationRow[]).map((conv) => {
      const otherId = convToOtherUser.get(conv.id);
      const recipient = otherId ? profileMap.get(otherId) : undefined;

      return {
        id: conv.id,
        type: conv.type,
        name: conv.name,
        iconUrl: conv.icon_url,
        recipient,
        unreadCount: unreadMap.get(conv.id) ?? 0,
        createdAt: conv.created_at,
      };
    });
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
