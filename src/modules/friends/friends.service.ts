import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PresenceStatus } from '../../shared/dto/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import type {
  FriendRequestsResponseDto,
  FriendRequestSummaryDto,
  FriendSummaryDto,
} from './dto/friend-response.dto';

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

  constructor(private readonly supabase: SupabaseService) {}

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
    return this.toRequestSummary(target, relationship.created_at);
  }

  async listFriends(userId: string): Promise<FriendSummaryDto[]> {
    const rows = await this.listRelationships(userId, 'accepted');
    if (rows.length === 0) {
      return [];
    }

    const profiles = await this.loadProfiles(
      rows.map((row) => this.otherUserId(row, userId)),
    );

    return rows.flatMap((row) => {
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
