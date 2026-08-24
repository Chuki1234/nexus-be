import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import type { PresenceStatus } from '../../shared/socket-events';
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

@Injectable()
export class PresenceService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(PresenceService.name);

  /** Thời gian ân hạn (ms) khi mất kết nối mạng / F5 trước khi phát tán offline */
  private readonly GRACE_PERIOD_MS = 15000;

  /** Quản lý danh sách socket IDs đang hoạt động của từng userId (cho in-memory mode) */
  private readonly userSockets = new Map<string, Set<string>>();

  /** Lookup ngược từ socketId -> userId */
  private readonly socketUser = new Map<string, string>();

  /** Timers đếm lùi offline theo userId (cho in-memory mode) */
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  /** Lưu timestamp ngắt kết nối gần nhất của user */
  private readonly lastSeenCache = new Map<string, string>();

  /** Cache manual_presence từ DB */
  private readonly manualPresenceCache = new Map<string, PresenceStatus>();

  /** Callback phát offline ra toàn cluster khi deadline hết hạn */
  private clusterOfflineHandler?: (payload: OfflineBroadcastPayload) => void;

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
  }

  setClusterOfflineHandler(
    handler: (payload: OfflineBroadcastPayload) => void,
  ): void {
    this.clusterOfflineHandler = handler;
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
      const { isFirstConnection } =
        await this.redisState.handleSocketConnect(userId, socketId, manual);
      const status: PresenceStatus =
        manual === 'dnd' || manual === 'idle' ? manual : 'online';
      const peers = await this.getUserPeers(userId);

      this.logger.log(
        `[Distributed] User ${userId} kết nối socket ${socketId} (isFirstConnection=${isFirstConnection}, status=${status})`,
      );

      return {
        userId,
        isFirstConnection,
        status,
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
    const peers = await this.getUserPeers(userId);

    return {
      userId,
      isFirstConnection,
      status,
      peers,
    };
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
  async setManualPresence(userId: string, status: PresenceStatus): Promise<void> {
    this.manualPresenceCache.set(userId, status);
    if (this.redisState.isDistributedActive()) {
      await this.redisState.setManualStatus(userId, status);
    }
  }

  /**
   * Lấy timestamp ngắt kết nối gần nhất của user
   */
  getLastSeenAt(userId: string): string | null {
    return this.lastSeenCache.get(userId) ?? null;
  }

  /**
   * Tìm tập hợp Peers liên quan (Accepted Friends + DM Conversation Peers) loại trừ chính userId
   */
  async getUserPeers(userId: string): Promise<string[]> {
    try {
      const [friendIds, dmPeerIds] = await Promise.all([
        this.friendsService.getAcceptedFriendUserIds(userId),
        this.conversationsService.getDmPeerUserIds(userId),
      ]);

      const peerSet = new Set<string>();
      for (const id of friendIds) {
        if (id && id !== userId) peerSet.add(id);
      }
      for (const id of dmPeerIds) {
        if (id && id !== userId) peerSet.add(id);
      }

      return Array.from(peerSet);
    } catch (err) {
      this.logger.error(`Lỗi lấy peer IDs cho user ${userId}:`, err);
      return [];
    }
  }

  /**
   * Lấy snapshot trạng thái hiện diện của tất cả peers của một user
   */
  async getPeersSnapshot(
    userId: string,
  ): Promise<
    Record<string, { status: PresenceStatus; lastSeenAt: string | null }>
  > {
    const peers = await this.getUserPeers(userId);
    const result: Record<
      string,
      { status: PresenceStatus; lastSeenAt: string | null }
    > = {};

    for (const peerId of peers) {
      if (this.redisState.isDistributedActive()) {
        const pres = await this.redisState.getUserPresence(peerId);
        result[peerId] = {
          status: ((pres?.status as PresenceStatus) || 'offline'),
          lastSeenAt: pres?.lastSeenAt ?? null,
        };
      } else {
        result[peerId] = {
          status: this.getEffectiveStatus(peerId),
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
      await this.supabase.client
        .from('profiles')
        .update({ last_seen_at: lastSeenAt })
        .eq('id', userId);
    } catch {
      // Gracefully ignored
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
    this.userSockets.clear();
    this.socketUser.clear();
  }
}
