import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import type { PresenceStatus, UserPresenceDto } from '../../shared/socket-events';
import { ConversationsService } from '../conversations/conversations.service';
import { FriendsService } from '../friends/friends.service';
import { RedisStateService } from './redis-state.service';

export interface PresenceConnectResult {
  userId: string;
  isFirstConnection: boolean;
  status: PresenceStatus;
  peers: string[];
}

export interface PresenceDisconnectResult {
  userId: string | null;
  isLastDisconnect: boolean;
}

export interface OfflineBroadcastPayload {
  userId: string;
  status: 'offline';
  lastSeenAt: string;
  peers: string[];
}

export interface IdleBroadcastPayload {
  userId: string;
  status: 'idle';
  peers: string[];
}

export interface ActivityBroadcastPayload {
  userId: string;
  status: PresenceStatus;
  peers: string[];
}

@Injectable()
export class PresenceService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(PresenceService.name);

  /** Thời gian ân hạn (ms) khi mất kết nối mạng / F5 trước khi phát tán offline */
  private readonly GRACE_PERIOD_MS = 15000;

  /** Thời gian không hoạt động (ms) trước khi chuyển sang idle */
  private readonly IDLE_AFTER_MS = 15 * 60 * 1000;

  /** Quản lý danh sách socket IDs đang hoạt động của từng userId (cho in-memory mode) */
  private readonly userSockets = new Map<string, Set<string>>();

  /** Lookup ngược từ socketId -> userId */
  private readonly socketUser = new Map<string, string>();

  /** Timers đếm lùi offline theo userId (cho in-memory mode) */
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  /** Timers đếm lùi idle theo userId (cho in-memory mode) */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  /** Trạng thái hiện diện in-memory của user */
  private readonly inMemoryStatus = new Map<string, PresenceStatus>();

  /** Lưu timestamp ngắt kết nối gần nhất của user */
  private readonly lastSeenCache = new Map<string, string>();

  /** Cache manual_presence từ DB */
  private readonly manualPresenceCache = new Map<string, PresenceStatus>();

  /** Callback phát offline ra toàn cluster khi deadline hết hạn */
  private clusterOfflineHandler?: (payload: OfflineBroadcastPayload) => void;

  /** Callback phát idle ra toàn cluster khi idle deadline hết hạn */
  private clusterIdleHandler?: (payload: IdleBroadcastPayload) => void;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly friendsService: FriendsService,
    private readonly conversationsService: ConversationsService,
    private readonly redisState: RedisStateService,
  ) {}

  onModuleInit(): void {
    this.redisState.setOfflineCallback(async ({ userId, lastSeenAt }) => {
      this.logger.log(`Cluster offline confirmed cho user ${userId} tại ${lastSeenAt}`);
      this.lastSeenCache.set(userId, lastSeenAt);
      await this.persistLastSeenAt(userId, lastSeenAt);

      if (this.clusterOfflineHandler) {
        const peers = await this.getUserPeers(userId);
        this.clusterOfflineHandler({
          userId,
          status: 'offline',
          lastSeenAt,
          peers,
        });
      }
    });

    this.redisState.setIdleCallback(async ({ userId }) => {
      this.logger.log(`Cluster idle confirmed cho user ${userId}`);
      if (this.clusterIdleHandler) {
        const peers = await this.getUserPeers(userId);
        this.clusterIdleHandler({
          userId,
          status: 'idle',
          peers,
        });
      }
    });
  }

  setClusterOfflineHandler(
    handler: (payload: OfflineBroadcastPayload) => void,
  ): void {
    this.clusterOfflineHandler = handler;
  }

  setClusterIdleHandler(
    handler: (payload: IdleBroadcastPayload) => void,
  ): void {
    this.clusterIdleHandler = handler;
  }

  /**
   * Xử lý khi một socket đã xác thực JWT thành công kết nối.
   */
  async handleUserConnect(
    userId: string,
    socketId: string,
  ): Promise<PresenceConnectResult> {
    if (!this.manualPresenceCache.has(userId)) {
      await this.loadManualPresence(userId);
    }
    const manual = this.manualPresenceCache.get(userId);

    this.socketUser.set(socketId, userId);

    if (this.redisState.isDistributedActive()) {
      const { isFirstConnection, status } =
        await this.redisState.handleSocketConnect(userId, socketId, manual);
      const effectiveStatus: PresenceStatus = (status as PresenceStatus) || 'online';
      const peers = await this.getUserPeers(userId);

      this.logger.log(
        `[Distributed] User ${userId} kết nối socket ${socketId} (isFirstConnection=${isFirstConnection}, status=${effectiveStatus})`,
      );

      return {
        userId,
        isFirstConnection,
        status: effectiveStatus,
        peers,
      };
    }

    // In-memory fallback
    const existingTimer = this.disconnectTimers.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.disconnectTimers.delete(userId);
    }

    let sockets = this.userSockets.get(userId);
    if (!sockets) {
      sockets = new Set<string>();
      this.userSockets.set(userId, sockets);
    }
    const isFirstConnection = sockets.size === 0;
    sockets.add(socketId);

    const status = this.getEffectiveStatus(userId);
    this.inMemoryStatus.set(userId, status);
    this.resetInMemoryIdleTimer(userId);

    const peers = await this.getUserPeers(userId);

    return {
      userId,
      isFirstConnection,
      status,
      peers,
    };
  }

  /**
   * Xử lý hoạt động tương tác từ user socket (throttled 30s từ client)
   */
  async handleUserActivity(
    socketId: string,
  ): Promise<ActivityBroadcastPayload | null> {
    const userId = this.socketUser.get(socketId);
    if (!userId) {
      return null;
    }

    if (this.redisState.isDistributedActive()) {
      const res = await this.redisState.handleUserActivity(userId, socketId);
      if (res.changedToOnline) {
        const peers = await this.getUserPeers(userId);
        return {
          userId,
          status: 'online',
          peers,
        };
      }
      return null;
    }

    // In-memory fallback
    const manual = this.manualPresenceCache.get(userId);
    if (manual === 'dnd' || manual === 'idle') {
      return null;
    }

    this.resetInMemoryIdleTimer(userId);
    const prevStatus = this.inMemoryStatus.get(userId) || 'online';
    if (prevStatus === 'idle') {
      this.inMemoryStatus.set(userId, 'online');
      const peers = await this.getUserPeers(userId);
      return {
        userId,
        status: 'online',
        peers,
      };
    }

    return null;
  }

  /**
   * Xử lý khi một socket ngắt kết nối.
   */
  async handleUserDisconnect(
    socketId: string,
    onOfflineCallback?: (payload: OfflineBroadcastPayload) => void,
  ): Promise<PresenceDisconnectResult> {
    const userId = this.socketUser.get(socketId);
    if (!userId) {
      return { userId: null, isLastDisconnect: false };
    }

    this.socketUser.delete(socketId);

    if (this.redisState.isDistributedActive()) {
      const { isLastDisconnect } =
        await this.redisState.handleSocketDisconnect(userId, socketId);
      this.logger.log(
        `[Distributed] Socket ${socketId} của user ${userId} ngắt kết nối (isLastDisconnect=${isLastDisconnect})`,
      );
      return { userId, isLastDisconnect };
    }

    // In-memory fallback
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(socketId);
    }

    const remainingCount = sockets?.size ?? 0;
    if (remainingCount > 0) {
      return { userId, isLastDisconnect: false };
    }

    const timer = setTimeout(async () => {
      this.disconnectTimers.delete(userId);
      const currentSockets = this.userSockets.get(userId);
      if (!currentSockets || currentSockets.size === 0) {
        this.userSockets.delete(userId);
        const lastSeenAt = new Date().toISOString();
        this.lastSeenCache.set(userId, lastSeenAt);

        this.persistLastSeenAt(userId, lastSeenAt).catch(() => {});

        if (onOfflineCallback) {
          const peers = await this.getUserPeers(userId);
          onOfflineCallback({
            userId,
            status: 'offline',
            lastSeenAt,
            peers,
          });
        }
      }
    }, this.GRACE_PERIOD_MS);

    this.disconnectTimers.set(userId, timer);

    return { userId, isLastDisconnect: true };
  }

  /**
   * Xử lý khi user chủ động đăng xuất (không qua grace period).
   */
  async handleExplicitLogout(
    userId: string,
  ): Promise<OfflineBroadcastPayload | null> {
    if (this.redisState.isDistributedActive()) {
      const lastSeenAt = await this.redisState.setExplicitOffline(userId);
      await this.persistLastSeenAt(userId, lastSeenAt);
      const peers = await this.getUserPeers(userId);
      return {
        userId,
        status: 'offline',
        lastSeenAt,
        peers,
      };
    }

    const timer = this.disconnectTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(userId);
    }

    const sockets = this.userSockets.get(userId);
    if (sockets) {
      for (const sId of sockets) {
        this.socketUser.delete(sId);
      }
      this.userSockets.delete(userId);
    }

    const lastSeenAt = new Date().toISOString();
    this.lastSeenCache.set(userId, lastSeenAt);
    await this.persistLastSeenAt(userId, lastSeenAt);

    const peers = await this.getUserPeers(userId);
    return {
      userId,
      status: 'offline',
      lastSeenAt,
      peers,
    };
  }

  /**
   * Tính toán trạng thái hiệu dụng (Effective Presence):
   */
  getEffectiveStatus(userId: string): PresenceStatus {
    const isConnected = (this.userSockets.get(userId)?.size ?? 0) > 0;
    if (!isConnected) {
      return 'offline';
    }

    const manual = this.manualPresenceCache.get(userId);
    if (manual === 'dnd' || manual === 'idle') {
      return manual;
    }
    return 'online';
  }

  /**
   * Cập nhật lựa chọn manual presence của user
   */
  async setManualPresence(userId: string, status: PresenceStatus | null): Promise<void> {
    if (status) {
      this.manualPresenceCache.set(userId, status);
    } else {
      this.manualPresenceCache.delete(userId);
    }

    if (this.redisState.isDistributedActive()) {
      await this.redisState.setManualStatus(userId, status);
    } else {
      const effective = this.getEffectiveStatus(userId);
      this.inMemoryStatus.set(userId, effective);
      this.resetInMemoryIdleTimer(userId);
    }
  }

  /**
   * Lấy timestamp ngắt kết nối gần nhất của user
   */
  getLastSeenAt(userId: string): string | null {
    return this.lastSeenCache.get(userId) ?? null;
  }

  /**
   * Reset bộ đếm 15 phút idle cho user (in-memory mode)
   */
  private resetInMemoryIdleTimer(userId: string): void {
    const existing = this.idleTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(userId);
    }

    const manual = this.manualPresenceCache.get(userId);
    if (manual === 'dnd' || manual === 'idle') {
      return;
    }

    const isConnected = (this.userSockets.get(userId)?.size ?? 0) > 0;
    if (!isConnected) {
      return;
    }

    const timer = setTimeout(async () => {
      this.idleTimers.delete(userId);
      const isStillConnected = (this.userSockets.get(userId)?.size ?? 0) > 0;
      const currentManual = this.manualPresenceCache.get(userId);
      if (isStillConnected && (!currentManual || currentManual === 'online')) {
        this.inMemoryStatus.set(userId, 'idle');
        if (this.clusterIdleHandler) {
          const peers = await this.getUserPeers(userId);
          this.clusterIdleHandler({
            userId,
            status: 'idle',
            peers,
          });
        }
      }
    }, this.IDLE_AFTER_MS);

    this.idleTimers.set(userId, timer);
  }

  /**
   * Tìm tập hợp peers liên quan tới một user.
   *
   * Presence không chỉ xuất hiện ở DM/bạn bè mà còn ở member list của server.
   * Vì mọi socket luôn join Room.user(userId), việc đưa shared-server members vào
   * đây giúp cùng một delta/snapshot canonical nuôi tất cả màn hình mà không phải
   * dựng một presence store riêng cho từng server.
   */
  async getUserPeers(userId: string): Promise<string[]> {
    try {
      const [friendIds, dmPeerIds, sharedServerMemberIds] = await Promise.all([
        this.friendsService.getAcceptedFriendUserIds(userId),
        this.conversationsService.getDmPeerUserIds(userId),
        this.getSharedServerMemberIds(userId),
      ]);

      const peerSet = new Set<string>();
      for (const id of friendIds) {
        if (id && id !== userId) peerSet.add(id);
      }
      for (const id of dmPeerIds) {
        if (id && id !== userId) peerSet.add(id);
      }
      for (const id of sharedServerMemberIds) {
        if (id && id !== userId) peerSet.add(id);
      }

      return Array.from(peerSet);
    } catch (err) {
      this.logger.error(`Lỗi lấy peer IDs cho user ${userId}:`, err);
      return [];
    }
  }

  /** Lấy toàn bộ user cùng tham gia ít nhất một server với user hiện tại. */
  private async getSharedServerMemberIds(userId: string): Promise<string[]> {
    try {
      const { data: memberships, error: membershipError } =
        await this.supabase.client
          .from('server_members')
          .select('server_id')
          .eq('user_id', userId);

      if (membershipError) {
        throw membershipError;
      }

      const serverIds = Array.from(
        new Set(
          (memberships ?? [])
            .map((item: { server_id: string }) => item.server_id)
            .filter(Boolean),
        ),
      );
      if (serverIds.length === 0) {
        return [];
      }

      const { data: members, error: membersError } =
        await this.supabase.client
          .from('server_members')
          .select('user_id')
          .in('server_id', serverIds);

      if (membersError) {
        throw membersError;
      }

      return Array.from(
        new Set(
          (members ?? [])
            .map((item: { user_id: string }) => item.user_id)
            .filter(Boolean),
        ),
      );
    } catch (error) {
      // Presence của friends/DM vẫn phải hoạt động nếu truy vấn shared server
      // tạm thời lỗi; không để một nguồn peer làm rỗng toàn bộ snapshot.
      this.logger.warn(
        `Không thể lấy shared-server presence peers cho user ${userId}`,
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  /**
   * Lấy snapshot trạng thái hiện diện của tất cả peers của một user
   */
  async getPeersSnapshot(
    userId: string,
  ): Promise<Record<string, UserPresenceDto>> {
    const peers = await this.getUserPeers(userId);
    const result: Record<string, UserPresenceDto> = {};

    // Bao gồm chính user để user panel/settings/member list không phải hardcode
    // trạng thái "online" và vẫn dùng đúng canonical presence store.
    for (const peerId of [userId, ...peers]) {
      if (this.redisState.isDistributedActive()) {
        const pres = await this.redisState.getUserPresence(peerId);
        result[peerId] = {
          userId: peerId,
          status: ((pres?.status as PresenceStatus) || 'offline'),
          lastSeenAt: pres?.lastSeenAt ?? null,
        };
      } else {
        const status = this.inMemoryStatus.get(peerId) || this.getEffectiveStatus(peerId);
        result[peerId] = {
          userId: peerId,
          status,
          lastSeenAt: this.getLastSeenAt(peerId),
        };
      }
    }

    return result;
  }

  /**
   * Kiểm tra xem user có bất kỳ socket nào đang kết nối không
   */
  isUserConnected(userId: string): boolean {
    return (this.userSockets.get(userId)?.size ?? 0) > 0;
  }

  private async loadManualPresence(userId: string): Promise<void> {
    try {
      const { data } = await this.supabase.client
        .from('profiles')
        .select('manual_presence')
        .eq('id', userId)
        .maybeSingle();

      if (data?.manual_presence) {
        this.manualPresenceCache.set(
          userId,
          data.manual_presence as PresenceStatus,
        );
      }
    } catch (err) {
      this.logger.warn(`Lỗi load manual_presence cho user ${userId}:`, err);
    }
  }

  private async persistLastSeenAt(
    userId: string,
    lastSeenAt: string,
  ): Promise<void> {
    try {
      // Ưu tiên monotonic update qua RPC nếu có
      const { error } = await this.supabase.client.rpc('update_profile_last_seen', {
        p_user_id: userId,
        p_last_seen_at: lastSeenAt,
      });
      if (error) {
        throw error;
      }
    } catch (error) {
      // Không fallback sang UPDATE trực tiếp: stale worker có thể làm timestamp lùi.
      this.logger.error(
        `Không thể cập nhật last_seen_at đơn điệu cho user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  onModuleDestroy(): void {
    this.cleanup();
  }

  onApplicationShutdown(): void {
    this.cleanup();
  }

  private cleanup(): void {
    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    this.userSockets.clear();
    this.socketUser.clear();
    this.inMemoryStatus.clear();
  }
}
