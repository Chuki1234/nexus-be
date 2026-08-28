import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PresenceStatus } from '../../shared/dto/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';
import { DirectCallsService } from '../direct-calls/direct-calls.service';
import type {
  FriendRequestsResponseDto,
  FriendRequestSummaryDto,
  FriendSummaryDto,
} from './dto/friend-response.dto';
import type { BlockedUserResponseDto } from './dto/blocked-user.dto';

interface RawFriendshipRow {
  user_a_id: string;
  user_b_id: string;
  requested_by: string;
  status: 'pending' | 'accepted' | 'blocked';
  created_at: string;
  updated_at: string;
}

interface RawProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status_message: string | null;
  manual_presence: string;
}

interface DatabaseError {
  code?: string;
  message: string;
}

const PROFILE_FIELDS =
  'id, username, display_name, avatar_url, status_message, manual_presence';
const FRIENDSHIP_FIELDS =
  'user_a_id, user_b_id, requested_by, status, created_at, updated_at';
const PRESENCE_VALUES = new Set<PresenceStatus>([
  'online',
  'idle',
  'dnd',
  'offline',
]);

@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async sendRequest(
    requesterId: string,
    username: string,
  ): Promise<FriendRequestSummaryDto> {
    const target = await this.findProfileByUsername(username);
    if (!target) {
      throw new NotFoundException('Không tìm thấy người dùng này.');
    }
    if (target.id === requesterId) {
      throw new BadRequestException('Bạn không thể tự gửi lời mời kết bạn.');
    }

    const [userAId, userBId] = this.orderedPair(requesterId, target.id);
    const existing = await this.findRelationship(userAId, userBId);
    if (existing) {
      throw new ConflictException(this.relationshipConflictMessage(existing));
    }

    const { data: blockData } = await this.supabase.client
      .from('user_blocks')
      .select('blocker_id')
      .or(
        `and(blocker_id.eq.${requesterId},blocked_user_id.eq.${target.id}),and(blocker_id.eq.${target.id},blocked_user_id.eq.${requesterId})`,
      )
      .limit(1);

    if (blockData && blockData.length > 0) {
      throw new BadRequestException('Không thể gửi lời mời kết bạn do có quan hệ chặn.');
    }

    const { data, error } = await this.supabase.client
      .from('friendships')
      .insert({
        user_a_id: userAId,
        user_b_id: userBId,
        requested_by: requesterId,
        status: 'pending',
      })
      .select(FRIENDSHIP_FIELDS)
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('Lời mời hoặc quan hệ bạn bè đã tồn tại.');
      }
      this.throwDatabaseError('Gửi lời mời kết bạn', error);
    }
    if (!data) {
      throw new InternalServerErrorException(
        'Không nhận được dữ liệu lời mời vừa tạo.',
      );
    }

    const relationship = data as RawFriendshipRow;

    // Realtime: báo cho người nhận để badge "chờ duyệt" cập nhật ngay (không cần
    // reload). Gateway sẽ tra hồ sơ người gửi rồi phát `notification:new` tới
    // user-room của người nhận (giữ service này không thêm query để không phá
    // chuỗi mock tuần tự của test).
    this.eventEmitter.emit(CHAT_EVENTS.FRIEND_REQUEST_RECEIVED, {
      recipientId: target.id,
      requesterId,
      createdAt: relationship.created_at,
    });

    return this.toRequestSummary(target, relationship.created_at);
  }

  async listFriends(userId: string): Promise<FriendSummaryDto[]> {
    const rows = await this.listRelationships(userId, 'accepted');
    if (rows.length === 0) {
      return [];
    }

    const allFriendIds = rows.map((row) => this.otherUserId(row, userId));
    const blockedSet = await this.getBlockedUserIds(userId, allFriendIds);
    const filteredRows = blockedSet.size > 0
      ? rows.filter((row) => !blockedSet.has(this.otherUserId(row, userId)))
      : rows;

    if (filteredRows.length === 0) {
      return [];
    }

    const profiles = await this.loadProfiles(
      filteredRows.map((row) => this.otherUserId(row, userId)),
    );

    return filteredRows.flatMap((row) => {
      const profile = profiles.get(this.otherUserId(row, userId));
      return profile ? [this.toFriendSummary(profile, row.updated_at)] : [];
    });
  }

  async listRequests(userId: string): Promise<FriendRequestsResponseDto> {
    const rows = await this.listRelationships(userId, 'pending');
    if (rows.length === 0) {
      return { incoming: [], outgoing: [] };
    }

    const profiles = await this.loadProfiles(
      rows.map((row) => this.otherUserId(row, userId)),
    );
    const result: FriendRequestsResponseDto = { incoming: [], outgoing: [] };

    for (const row of rows) {
      const profile = profiles.get(this.otherUserId(row, userId));
      if (!profile) continue;

      const summary = this.toRequestSummary(profile, row.created_at);
      if (row.requested_by === userId) {
        result.outgoing.push(summary);
      } else {
        result.incoming.push(summary);
      }
    }

    return result;
  }

  async acceptRequest(
    userId: string,
    requesterId: string,
  ): Promise<FriendSummaryDto> {
    if (userId === requesterId) {
      throw new BadRequestException('Không thể chấp nhận lời mời của chính bạn.');
    }

    const [userAId, userBId] = this.orderedPair(userId, requesterId);
    const relationship = await this.findRelationship(userAId, userBId);
    if (!relationship) {
      throw new NotFoundException('Lời mời kết bạn không tồn tại.');
    }
    if (relationship.status !== 'pending') {
      throw new ConflictException(
        'Quan hệ này không còn ở trạng thái chờ duyệt.',
      );
    }
    if (relationship.requested_by === userId) {
      throw new BadRequestException(
        'Bạn không thể chấp nhận lời mời do mình gửi.',
      );
    }

    const { data, error } = await this.supabase.client
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('user_a_id', userAId)
      .eq('user_b_id', userBId)
      .eq('status', 'pending')
      .select(FRIENDSHIP_FIELDS)
      .maybeSingle();

    if (error) {
      this.throwDatabaseError('Chấp nhận lời mời kết bạn', error);
    }
    if (!data) {
      throw new ConflictException('Lời mời vừa được xử lý ở một phiên khác.');
    }

    // Đã là bạn bè: nếu trước đó có DM "người lạ" đang chờ duyệt thì mở khoá luôn
    // (không còn là message request nữa).
    const dmKey = `${userAId}:${userBId}`;
    const { data: dmConv } = await this.supabase.client
      .from('conversations')
      .select('id')
      .eq('dm_key', dmKey)
      .maybeSingle();
    if (dmConv?.id) {
      await this.supabase.client
        .from('conversation_participants')
        .update({ request_state: 'accepted' })
        .eq('conversation_id', dmConv.id as string);
    }

    const profiles = await this.loadProfiles([requesterId]);
    const requester = profiles.get(requesterId);
    if (!requester) {
      throw new InternalServerErrorException(
        'Không tải được hồ sơ người gửi lời mời.',
      );
    }

    return this.toFriendSummary(
      requester,
      (data as RawFriendshipRow).updated_at,
    );
  }

  async deleteRequest(userId: string, otherUserId: string): Promise<void> {
    await this.deleteRelationship(
      userId,
      otherUserId,
      'pending',
      'Lời mời kết bạn không tồn tại.',
    );
  }

  async removeFriend(userId: string, friendId: string): Promise<void> {
    await this.deleteRelationship(
      userId,
      friendId,
      'accepted',
      'Quan hệ bạn bè không tồn tại.',
    );

    // Xóa hoàn toàn cuộc trò chuyện trực tiếp (DM) và tất cả tin nhắn giữa hai người
    const [userAId, userBId] = this.orderedPair(userId, friendId);
    const dmKey = `${userAId}:${userBId}`;

    try {
      const { data: conv } = await this.supabase.client
        .from('conversations')
        .select('id')
        .eq('dm_key', dmKey)
        .maybeSingle();

      if (conv?.id) {
        const convId = conv.id as string;
        const { error: delConvErr } = await this.supabase.client
          .from('conversations')
          .delete()
          .eq('id', convId);

        if (delConvErr) {
          this.logger.error('Lỗi xóa cuộc trò chuyện khi hủy kết bạn:', delConvErr);
        }

        // Phát realtime sự kiện conversation:deleted tới user-room của cả 2 phía
        this.eventEmitter.emit(CHAT_EVENTS.CONVERSATION_DELETED, {
          conversationId: convId,
          userId,
          friendId,
        });
      }
    } catch (err) {
      this.logger.error('Lỗi dọn dẹp conversation khi removeFriend:', err);
    }
  }

  /**
   * Lấy danh sách người dùng bị chặn bởi user hiện tại
   */
  async listBlockedUsers(userId: string): Promise<BlockedUserResponseDto[]> {
    const { data, error } = await this.supabase.client.rpc('list_blocked_users', {
      p_user_id: userId,
    });

    if (!error && Array.isArray(data)) {
      return data.map((row: {
        id: string;
        username: string;
        display_name: string | null;
        avatar_url: string | null;
        blocked_at: string;
      }) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        blockedAt: row.blocked_at,
      }));
    }

    // Fallback: Nếu RPC lỗi (do schema/type mismatch trên remote DB cũ), truy vấn trực tiếp từ bảng user_blocks
    this.logger.warn(
      `RPC list_blocked_users lỗi (${error?.message}), chuyển sang fallback query từ bảng user_blocks.`,
    );

    const { data: blockRows, error: blockErr } = await this.supabase.client
      .from('user_blocks')
      .select('blocked_user_id, created_at')
      .eq('blocker_id', userId)
      .order('created_at', { ascending: false });

    if (blockErr) {
      this.throwDatabaseError('Lấy danh sách người dùng bị chặn', blockErr);
    }

    if (!blockRows || blockRows.length === 0) {
      return [];
    }

    const profiles = await this.loadProfiles(
      blockRows.map((r) => r.blocked_user_id as string),
    );

    return blockRows.flatMap((row) => {
      const p = profiles.get(row.blocked_user_id as string);
      if (!p) return [];
      return [
        {
          id: p.id,
          username: p.username,
          displayName: p.display_name ?? null,
          avatarUrl: p.avatar_url ?? null,
          blockedAt: row.created_at as string,
        },
      ];
    });
  }

  /**
   * Chặn người dùng: Thêm vào user_blocks, xóa bạn bè, dọn dẹp cuộc gọi active,
   * phát event user:block-created cho người chặn và relationship:invalidated cho người bị chặn.
   */
  async blockUser(
    userId: string,
    targetUserId: string,
  ): Promise<BlockedUserResponseDto> {
    if (userId === targetUserId) {
      throw new BadRequestException('Bạn không thể tự chặn chính mình.');
    }

    const { data, error } = await this.supabase.client.rpc('block_user', {
      p_blocker_id: userId,
      p_blocked_user_id: targetUserId,
    });

    if (error) {
      if (error.code === '22023') {
        throw new BadRequestException(error.message || 'Yêu cầu không hợp lệ.');
      }
      if (error.code === 'P0002') {
        throw new NotFoundException('Không tìm thấy người dùng.');
      }
      this.throwDatabaseError('Chặn người dùng', error);
    }

    const result = data as {
      blocked_user: {
        id: string;
        username: string;
        displayName: string | null;
        avatarUrl: string | null;
        blockedAt: string;
      };
      terminated_call_ids?: string[];
    };

    const blockedUserDto: BlockedUserResponseDto = {
      id: result.blocked_user.id,
      username: result.blocked_user.username,
      displayName: result.blocked_user.displayName,
      avatarUrl: result.blocked_user.avatarUrl,
      blockedAt: result.blocked_user.blockedAt,
    };

    // 1. Phát event user:block-created tới user-room của blocker (A)
    this.eventEmitter.emit(CHAT_EVENTS.USER_BLOCK_CREATED, {
      blockerId: userId,
      blockedUser: blockedUserDto,
    });

    // 2. Phát event trung tính relationship:invalidated tới user-room của người bị chặn (B)
    this.eventEmitter.emit(CHAT_EVENTS.RELATIONSHIP_INVALIDATED, {
      targetUserId: targetUserId,
      invalidatedWithUserId: userId,
    });

    // 3. Nếu có cuộc gọi bị terminate, emit direct_call.terminated qua event emitter
    if (result.terminated_call_ids && result.terminated_call_ids.length > 0) {
      for (const callId of result.terminated_call_ids) {
        this.eventEmitter.emit(CHAT_EVENTS.DIRECT_CALL_TERMINATED, { callId });
      }
    }

    return blockedUserDto;
  }

  /**
   * Bỏ chặn người dùng: Xóa khỏi user_blocks, phát event user:block-removed cho người chặn.
   */
  async unblockUser(userId: string, targetUserId: string): Promise<void> {
    if (userId === targetUserId) {
      throw new BadRequestException('Người dùng không hợp lệ.');
    }

    const { error } = await this.supabase.client.rpc('unblock_user', {
      p_blocker_id: userId,
      p_blocked_user_id: targetUserId,
    });

    if (error) {
      this.throwDatabaseError('Bỏ chặn người dùng', error);
    }

    this.eventEmitter.emit(CHAT_EVENTS.USER_BLOCK_REMOVED, {
      blockerId: userId,
      blockedUserId: targetUserId,
    });
  }

  /**
   * Danh sách userId mà user hiện tại đã TẮT THÔNG BÁO DM (đồng bộ theo tài khoản).
   */
  async listMutedUserIds(userId: string): Promise<string[]> {
    const { data, error } = await this.supabase.client
      .from('dm_notification_mutes')
      .select('muted_user_id')
      .eq('user_id', userId);

    if (error) {
      this.throwDatabaseError('Tải danh sách tắt thông báo', error);
    }

    return ((data as Array<{ muted_user_id: string }> | null) ?? []).map(
      (row) => row.muted_user_id,
    );
  }

  /** Tắt thông báo DM từ một người (idempotent). */
  async muteUser(userId: string, targetUserId: string): Promise<void> {
    if (userId === targetUserId) {
      throw new BadRequestException('Người dùng không hợp lệ.');
    }

    const { error } = await this.supabase.client
      .from('dm_notification_mutes')
      .upsert(
        { user_id: userId, muted_user_id: targetUserId },
        { onConflict: 'user_id,muted_user_id', ignoreDuplicates: true },
      );

    if (error) {
      this.throwDatabaseError('Tắt thông báo người dùng', error);
    }
  }

  /** Bật lại thông báo DM từ một người (idempotent). */
  async unmuteUser(userId: string, targetUserId: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('dm_notification_mutes')
      .delete()
      .eq('user_id', userId)
      .eq('muted_user_id', targetUserId);

    if (error) {
      this.throwDatabaseError('Bật lại thông báo người dùng', error);
    }
  }

  private async deleteRelationship(
    userId: string,
    otherUserId: string,
    expectedStatus: 'pending' | 'accepted',
    notFoundMessage: string,
  ): Promise<void> {
    if (userId === otherUserId) {
      throw new BadRequestException('Người dùng đích không hợp lệ.');
    }

    const [userAId, userBId] = this.orderedPair(userId, otherUserId);
    const relationship = await this.findRelationship(userAId, userBId);
    if (!relationship || relationship.status !== expectedStatus) {
      throw new NotFoundException(notFoundMessage);
    }

    const { error } = await this.supabase.client
      .from('friendships')
      .delete()
      .eq('user_a_id', userAId)
      .eq('user_b_id', userBId)
      .eq('status', expectedStatus);

    if (error) {
      this.throwDatabaseError('Xóa quan hệ bạn bè', error);
    }
  }

  private async findProfileByUsername(
    username: string,
  ): Promise<RawProfileRow | null> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select(PROFILE_FIELDS)
      .eq('username', username.trim().toLowerCase())
      .maybeSingle();

    if (error) {
      this.throwDatabaseError('Tìm người dùng', error);
    }
    return (data as RawProfileRow | null) ?? null;
  }

  private async findRelationship(
    userAId: string,
    userBId: string,
  ): Promise<RawFriendshipRow | null> {
    const { data, error } = await this.supabase.client
      .from('friendships')
      .select(FRIENDSHIP_FIELDS)
      .eq('user_a_id', userAId)
      .eq('user_b_id', userBId)
      .maybeSingle();

    if (error) {
      this.throwDatabaseError('Kiểm tra quan hệ bạn bè', error);
    }
    return (data as RawFriendshipRow | null) ?? null;
  }

  async getAcceptedFriendUserIds(userId: string): Promise<string[]> {
    try {
      const rows = await this.listRelationships(userId, 'accepted');
      if (rows.length === 0) return [];
      const allIds = rows.map((row) => this.otherUserId(row, userId));
      const blockedSet = await this.getBlockedUserIds(userId, allIds);
      return blockedSet.size > 0
        ? allIds.filter((id) => !blockedSet.has(id))
        : allIds;
    } catch {
      return [];
    }
  }

  /**
   * Trả về tập ID bị block theo cả 2 chiều (userId block họ, hoặc họ block userId)
   * trong danh sách candidateIds cho trước.
   */
  private async getBlockedUserIds(
    userId: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();

    const orFilter = candidateIds
      .map(
        (id) =>
          `and(blocker_id.eq.${userId},blocked_user_id.eq.${id}),and(blocker_id.eq.${id},blocked_user_id.eq.${userId})`,
      )
      .join(',');

    const { data } = await this.supabase.client
      .from('user_blocks')
      .select('blocker_id, blocked_user_id')
      .or(orFilter);

    const blocked = new Set<string>();
    for (const row of (
      data as Array<{ blocker_id: string; blocked_user_id: string }> | null
    ) ?? []) {
      blocked.add(row.blocker_id === userId ? row.blocked_user_id : row.blocker_id);
    }
    return blocked;
  }

  private async listRelationships(
    userId: string,
    status: 'pending' | 'accepted',
  ): Promise<RawFriendshipRow[]> {
    const { data, error } = await this.supabase.client
      .from('friendships')
      .select(FRIENDSHIP_FIELDS)
      .eq('status', status)
      .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
      .order('created_at', { ascending: true });

    if (error) {
      this.throwDatabaseError('Tải danh sách quan hệ bạn bè', error);
    }
    return (data as RawFriendshipRow[] | null) ?? [];
  }

  private async loadProfiles(ids: string[]): Promise<Map<string, RawProfileRow>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const { data, error } = await this.supabase.client
      .from('profiles')
      .select(PROFILE_FIELDS)
      .in('id', uniqueIds);

    if (error) {
      this.throwDatabaseError('Tải hồ sơ bạn bè', error);
    }

    return new Map(
      ((data as RawProfileRow[] | null) ?? []).map((profile) => [
        profile.id,
        profile,
      ]),
    );
  }

  private orderedPair(firstId: string, secondId: string): [string, string] {
    return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
  }

  private otherUserId(row: RawFriendshipRow, currentUserId: string): string {
    return row.user_a_id === currentUserId ? row.user_b_id : row.user_a_id;
  }

  private toFriendSummary(
    profile: RawProfileRow,
    friendsSince: string,
  ): FriendSummaryDto {
    return {
      ...this.publicProfile(profile),
      friendsSince,
    };
  }

  private toRequestSummary(
    profile: RawProfileRow,
    requestedAt: string,
  ): FriendRequestSummaryDto {
    return {
      ...this.publicProfile(profile),
      requestedAt,
    };
  }

  private publicProfile(
    profile: RawProfileRow,
  ): Omit<FriendSummaryDto, 'friendsSince'> {
    return {
      id: profile.id,
      username: profile.username,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      statusMessage: profile.status_message,
      presence: PRESENCE_VALUES.has(profile.manual_presence as PresenceStatus)
        ? (profile.manual_presence as PresenceStatus)
        : 'offline',
    };
  }

  private relationshipConflictMessage(row: RawFriendshipRow): string {
    if (row.status === 'accepted') {
      return 'Hai người đã là bạn bè.';
    }
    if (row.status === 'blocked') {
      return 'Không thể gửi lời mời cho người dùng này.';
    }
    return 'Lời mời kết bạn đã tồn tại.';
  }

  private throwDatabaseError(context: string, error: DatabaseError): never {
    this.logger.error(`${context} thất bại: ${error.message}`);

    if (
      error.code === '42P01' ||
      error.code === 'PGRST204' ||
      error.message.includes('relation')
    ) {
      throw new ServiceUnavailableException(
        'Cơ sở dữ liệu bạn bè chưa sẵn sàng. Vui lòng kiểm tra migration Supabase.',
      );
    }

    throw new InternalServerErrorException(
      'Không thể hoàn tất thao tác bạn bè. Vui lòng thử lại sau.',
    );
  }
}
