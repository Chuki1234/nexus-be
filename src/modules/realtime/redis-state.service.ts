import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import * as os from 'os';
import type { VoiceMemberState } from '../../shared/socket-events';

export interface PresenceSnapshotItem {
  status: string;
  manualStatus?: string | null;
  lastSeenAt: string | null;
  activeSocketCount: number;
}

@Injectable()
export class RedisStateService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(RedisStateService.name);

  private client: Redis | null = null;
  private isConnected = false;

  readonly instanceId: string;
  readonly keyPrefix: string;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private deadInstanceSweeperTimer: NodeJS.Timeout | null = null;
  private offlineProcessorTimer: NodeJS.Timeout | null = null;
  private typingSweeperTimer: NodeJS.Timeout | null = null;

  /** In-memory fallback lưu trữ voice states khi không có Redis */
  private readonly inMemoryVoiceStates = new Map<string, Map<string, VoiceMemberState>>();

  // Callbacks
  private onOfflineCallback?: (payload: {
    userId: string;
    lastSeenAt: string;
  }) => void;
  private onTypingUpdateCallback?: (payload: {
    targetId: string;
    isChannel: boolean;
    userIds: string[];
  }) => void;

  constructor() {
    this.instanceId =
      process.env.INSTANCE_ID ||
      `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.keyPrefix = process.env.REDIS_KEY_PREFIX || 'nexuscord:dev:';
  }

  async onModuleInit(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('REDIS_URL không được cấu hình — chạy chế độ Presence in-memory cục bộ');
      return;
    }

    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });

      this.client.on('error', (err) => {
        this.logger.error(`RedisStateService error: ${err.message}`, err.stack);
      });

      await new Promise<void>((resolve, reject) => {
        if (this.client!.status === 'ready') return resolve();
        this.client!.once('ready', resolve);
        this.client!.once('error', reject);
      });

      this.isConnected = true;
      this.logger.log(
        `RedisStateService kết nối thành công: instanceId=${this.instanceId}, prefix=${this.keyPrefix}`,
      );

      await this.registerInstance();
      this.startHeartbeat();
      this.startDeadInstanceSweeper();
      this.startOfflineProcessor();
      this.startTypingSweeper();
    } catch (err: any) {
      this.logger.error(`Lỗi khởi tạo RedisStateService: ${err.message}`, err.stack);
      if (process.env.REALTIME_DISTRIBUTED === 'true') {
        throw new Error(`Fail-fast bootstrap: Không thể kết nối RedisStateService tại ${redisUrl} (${err.message})`);
      }
    }
  }

  isDistributedActive(): boolean {
    return this.isConnected && this.client !== null;
  }

  setOfflineCallback(
    cb: (payload: { userId: string; lastSeenAt: string }) => void,
  ): void {
    this.onOfflineCallback = cb;
  }

  setTypingUpdateCallback(
    cb: (payload: {
      targetId: string;
      isChannel: boolean;
      userIds: string[];
    }) => void,
  ): void {
    this.onTypingUpdateCallback = cb;
  }

  // ---------------------------------------------------------------------------
  // Helper tạo key có prefix (không double prefix)
  // ---------------------------------------------------------------------------
  k(name: string): string {
    return `${this.keyPrefix}${name}`;
  }

  // ---------------------------------------------------------------------------
  // 1. Instance Lifecycle & Heartbeat
  // ---------------------------------------------------------------------------
  private async registerInstance(): Promise<void> {
    if (!this.client) return;
    await this.client.sadd(this.k('presence:instances'), this.instanceId);
    await this.client.set(
      this.k(`presence:instance:${this.instanceId}:heartbeat`),
      '1',
      'EX',
      15,
    );
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        if (!this.client || !this.isConnected) return;
        await this.client.set(
          this.k(`presence:instance:${this.instanceId}:heartbeat`),
          '1',
          'EX',
          15,
        );
      } catch (err: any) {
        this.logger.warn(`Lỗi refresh heartbeat cho instance ${this.instanceId}: ${err.message}`);
      }
    }, 5000);
  }

  // ---------------------------------------------------------------------------
  // 2. Atomic Connect / Disconnect (Lua Scripts)
  // ---------------------------------------------------------------------------
  async handleSocketConnect(
    userId: string,
    socketId: string,
    manualStatus?: string | null,
  ): Promise<{ isFirstConnection: boolean; activeSocketCount: number }> {
    if (!this.client || !this.isConnected) {
      return { isFirstConnection: true, activeSocketCount: 1 };
    }

    const sockKey = this.k(`presence:sockets:${userId}`);
    const instUsersKey = this.k(`presence:instance:${this.instanceId}:users`);
    const activeUsersKey = this.k('presence:active_users');
    const deadlineKey = this.k('presence:offline_deadlines');
    const userKey = this.k(`presence:user:${userId}`);

    const nowIso = new Date().toISOString();
    const defaultStatus = manualStatus && manualStatus !== 'offline' ? manualStatus : 'online';

    // Lua script atomic connect:
    // Thêm socket, user vào reverse index và active_users, xóa khỏi offline_deadlines,
    // cập nhật activeSocketCount, trả về previous count.
    const luaScript = `
      local sockKey = KEYS[1]
      local instUsersKey = KEYS[2]
      local activeUsersKey = KEYS[3]
      local deadlineKey = KEYS[4]
      local userKey = KEYS[5]

      local instanceId = ARGV[1]
      local socketId = ARGV[2]
      local nowIso = ARGV[3]
      local userId = ARGV[4]
      local defaultStatus = ARGV[5]

      local socketField = instanceId .. ':' .. socketId
      local prevCount = redis.call('HLEN', sockKey)

      redis.call('HSET', sockKey, socketField, nowIso)
      redis.call('SADD', instUsersKey, userId)
      redis.call('SADD', activeUsersKey, userId)
      redis.call('ZREM', deadlineKey, userId)

      local currentCount = redis.call('HLEN', sockKey)
      redis.call('HSET', userKey, 'activeSocketCount', currentCount)

      local existingManual = redis.call('HGET', userKey, 'manualStatus')
      if existingManual and existingManual ~= '' and existingManual ~= 'offline' then
        redis.call('HSET', userKey, 'status', existingManual)
      else
        redis.call('HSET', userKey, 'status', defaultStatus)
      end

      return prevCount
    `;

    const prevCount = (await this.client.eval(
      luaScript,
      5,
      sockKey,
      instUsersKey,
      activeUsersKey,
      deadlineKey,
      userKey,
      this.instanceId,
      socketId,
      nowIso,
      userId,
      defaultStatus,
    )) as number;

    return {
      isFirstConnection: prevCount === 0,
      activeSocketCount: prevCount + 1,
    };
  }

  async handleSocketDisconnect(
    userId: string,
    socketId: string,
  ): Promise<{ isLastDisconnect: boolean; remainingSockets: number }> {
    if (!this.client || !this.isConnected) {
      return { isLastDisconnect: true, remainingSockets: 0 };
    }

    const sockKey = this.k(`presence:sockets:${userId}`);
    const instUsersKey = this.k(`presence:instance:${this.instanceId}:users`);
    const deadlineKey = this.k('presence:offline_deadlines');
    const userKey = this.k(`presence:user:${userId}`);

    const nowMs = Date.now();
    const deadlineMs = nowMs + 15000;

    // Lua script atomic disconnect:
    // Xóa socket, dọn reverse index nếu hết socket trên instance này,
    // đếm remaining. Nếu remaining == 0 -> đẩy vào offline_deadlines.
    const luaScript = `
      local sockKey = KEYS[1]
      local instUsersKey = KEYS[2]
      local deadlineKey = KEYS[3]
      local userKey = KEYS[4]

      local instanceId = ARGV[1]
      local socketId = ARGV[2]
      local userId = ARGV[3]
      local deadlineMs = tonumber(ARGV[4])

      local socketField = instanceId .. ':' .. socketId
      redis.call('HDEL', sockKey, socketField)

      local allFields = redis.call('HKEYS', sockKey)
      local hasInstanceSocket = false
      local instPrefix = instanceId .. ':'
      for i, field in ipairs(allFields) do
        if string.sub(field, 1, string.len(instPrefix)) == instPrefix then
          hasInstanceSocket = true
          break
        end
      end
      if not hasInstanceSocket then
        redis.call('SREM', instUsersKey, userId)
      end

      local remaining = #allFields
      redis.call('HSET', userKey, 'activeSocketCount', remaining)
      if remaining == 0 then
        redis.call('ZADD', deadlineKey, deadlineMs, userId)
      end
      return remaining
    `;

    const remaining = (await this.client.eval(
      luaScript,
      4,
      sockKey,
      instUsersKey,
      deadlineKey,
      userKey,
      this.instanceId,
      socketId,
      userId,
      deadlineMs.toString(),
    )) as number;

    return {
      isLastDisconnect: remaining === 0,
      remainingSockets: remaining,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. User Presence State & Snapshots
  // ---------------------------------------------------------------------------
  async getUserPresence(userId: string): Promise<PresenceSnapshotItem | null> {
    if (!this.client || !this.isConnected) return null;
    const userKey = this.k(`presence:user:${userId}`);
    const data = await this.client.hgetall(userKey);
    if (!data || Object.keys(data).length === 0) return null;

    return {
      status: data.status || 'offline',
      manualStatus: data.manualStatus || null,
      lastSeenAt: data.lastSeenAt || null,
      activeSocketCount: parseInt(data.activeSocketCount || '0', 10),
    };
  }

  async setManualStatus(userId: string, manualStatus: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    const userKey = this.k(`presence:user:${userId}`);
    await this.client.hset(userKey, 'manualStatus', manualStatus);
    const sockCount = await this.client.hlen(this.k(`presence:sockets:${userId}`));
    if (sockCount > 0) {
      await this.client.hset(userKey, 'status', manualStatus);
    }
  }

  async setExplicitOffline(userId: string): Promise<string> {
    const nowIso = new Date().toISOString();
    if (!this.client || !this.isConnected) return nowIso;

    const sockKey = this.k(`presence:sockets:${userId}`);
    const instUsersKey = this.k(`presence:instance:${this.instanceId}:users`);
    const activeUsersKey = this.k('presence:active_users');
    const deadlineKey = this.k('presence:offline_deadlines');
    const userKey = this.k(`presence:user:${userId}`);

    const luaScript = `
      redis.call('DEL', KEYS[1])
      redis.call('SREM', KEYS[2], ARGV[1])
      redis.call('SREM', KEYS[3], ARGV[1])
      redis.call('ZREM', KEYS[4], ARGV[1])
      redis.call('HSET', KEYS[5], 'status', 'offline', 'lastSeenAt', ARGV[2], 'activeSocketCount', 0)
      return 1
    `;

    await this.client.eval(
      luaScript,
      5,
      sockKey,
      instUsersKey,
      activeUsersKey,
      deadlineKey,
      userKey,
      userId,
      nowIso,
    );

    return nowIso;
  }

  // ---------------------------------------------------------------------------
  // 4. Dead-Instance Sweeper (Mỗi 10s)
  // ---------------------------------------------------------------------------
  private startDeadInstanceSweeper(): void {
    this.deadInstanceSweeperTimer = setInterval(async () => {
      try {
        if (!this.client || !this.isConnected) return;
        await this.sweepDeadInstances();
      } catch (err: any) {
        this.logger.warn(`Lỗi dead-instance sweeper: ${err.message}`);
      }
    }, 10000);
  }

  async sweepDeadInstances(): Promise<{ deadInstances: number; cleanedSockets: number }> {
    if (!this.client || !this.isConnected) return { deadInstances: 0, cleanedSockets: 0 };
    const instances = await this.client.smembers(this.k('presence:instances'));
    const nowMs = Date.now();
    const deadlineMs = nowMs + 15000;
    let deadCount = 0;
    let socketsCount = 0;

    for (const instId of instances) {
      if (instId === this.instanceId) continue;

      const heartbeat = await this.client.exists(
        this.k(`presence:instance:${instId}:heartbeat`),
      );
      if (heartbeat === 0) {
        deadCount++;
        this.logger.warn(`Phát hiện instance chết: ${instId} — tiến hành dọn dẹp`);
        const deadUsersKey = this.k(`presence:instance:${instId}:users`);
        const users = await this.client.smembers(deadUsersKey);

        const luaCleanupScript = `
          local sockKey = KEYS[1]
          local deadlineKey = KEYS[2]
          local userKey = KEYS[3]

          local deadInst = ARGV[1]
          local userId = ARGV[2]
          local deadlineMs = tonumber(ARGV[3])

          local deadPrefix = deadInst .. ':'
          local allFields = redis.call('HKEYS', sockKey)
          local cleaned = 0
          for i, field in ipairs(allFields) do
            if string.sub(field, 1, string.len(deadPrefix)) == deadPrefix then
              redis.call('HDEL', sockKey, field)
              cleaned = cleaned + 1
            end
          end

          local remaining = redis.call('HLEN', sockKey)
          redis.call('HSET', userKey, 'activeSocketCount', remaining)
          if remaining == 0 then
            redis.call('ZADD', deadlineKey, deadlineMs, userId)
          end
          return cleaned
        `;

        for (const uId of users) {
          try {
            const cleaned = (await this.client.eval(
              luaCleanupScript,
              3,
              this.k(`presence:sockets:${uId}`),
              this.k('presence:offline_deadlines'),
              this.k(`presence:user:${uId}`),
              instId,
              uId,
              deadlineMs.toString(),
            )) as number;
            socketsCount += cleaned;
          } catch (err: any) {
            this.logger.error(`Lỗi dọn socket user ${uId} từ dead instance ${instId}: ${err.message}`);
          }
        }

        await this.client.del(deadUsersKey);
        await this.client.srem(this.k('presence:instances'), instId);
        this.logger.log(`Hoàn tất dọn dẹp instance chết ${instId}`);
      }
    }
    return { deadInstances: deadCount, cleanedSockets: socketsCount };
  }

  // ---------------------------------------------------------------------------
  // 5. Offline Deadline Processor & Token-Safe Distributed Lock (Mỗi 3s)
  // ---------------------------------------------------------------------------
  private startOfflineProcessor(): void {
    this.offlineProcessorTimer = setInterval(async () => {
      try {
        if (!this.client || !this.isConnected) return;
        await this.processOfflineDeadlines();
      } catch (err: any) {
        this.logger.warn(`Lỗi processOfflineDeadlines: ${err.message}`);
      }
    }, 3000);
  }

  async processOfflineDeadlines(): Promise<void> {
    if (!this.client || !this.isConnected) return;
    const nowMs = Date.now();
    const expiredUsers = await this.client.zrangebyscore(
      this.k('presence:offline_deadlines'),
      0,
      nowMs,
      'LIMIT',
      0,
      50,
    );

    if (!expiredUsers || expiredUsers.length === 0) return;

    const workerToken = `${this.instanceId}-${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();

    for (const userId of expiredUsers) {
      const lockKey = this.k(`lock:presence:offline:${userId}`);
      const acquired = await this.client.set(lockKey, workerToken, 'PX', 10000, 'NX');
      if (acquired !== 'OK') continue;

      try {
        const luaConfirmScript = `
          local sockKey = KEYS[1]
          local deadlineKey = KEYS[2]
          local activeUsersKey = KEYS[3]
          local userKey = KEYS[4]

          local userId = ARGV[1]
          local nowIso = ARGV[2]

          local remaining = redis.call('HLEN', sockKey)
          if remaining == 0 then
            local removed = redis.call('ZREM', deadlineKey, userId)
            if removed == 1 then
              redis.call('SREM', activeUsersKey, userId)
              redis.call('HSET', userKey, 'status', 'offline', 'lastSeenAt', nowIso, 'activeSocketCount', 0)
              return 1
            end
          else
            redis.call('ZREM', deadlineKey, userId)
            return 0
          end
          return 0
        `;

        const result = (await this.client.eval(
          luaConfirmScript,
          4,
          this.k(`presence:sockets:${userId}`),
          this.k('presence:offline_deadlines'),
          this.k('presence:active_users'),
          this.k(`presence:user:${userId}`),
          userId,
          nowIso,
        )) as number;

        if (result === 1 && this.onOfflineCallback) {
          this.onOfflineCallback({ userId, lastSeenAt: nowIso });
        }
      } finally {
        const luaReleaseLock = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
          else
            return 0
          end
        `;
        await this.client.eval(luaReleaseLock, 1, lockKey, workerToken).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Distributed Typing Indicators & Active Sweeper
  // ---------------------------------------------------------------------------
  async startTyping(
    targetId: string,
    isChannel: boolean,
    userId: string,
  ): Promise<string[]> {
    if (!this.client || !this.isConnected) return [userId];

    const targetKeyName = isChannel ? `chan:${targetId}` : `conv:${targetId}`;
    const targetsSetKey = this.k('typing:targets');
    const targetZSetKey = this.k(`typing:${targetKeyName}`);

    const nowMs = Date.now();
    const expiryMs = nowMs + 5000;

    const luaScript = `
      local targetsKey = KEYS[1]
      local zsetKey = KEYS[2]
      local target = ARGV[1]
      local userId = ARGV[2]
      local nowMs = tonumber(ARGV[3])
      local expiryMs = tonumber(ARGV[4])

      redis.call('SADD', targetsKey, target)
      redis.call('ZREMRANGEBYSCORE', zsetKey, 0, nowMs)
      redis.call('ZADD', zsetKey, expiryMs, userId)
      return redis.call('ZRANGEBYSCORE', zsetKey, nowMs, '+inf')
    `;

    const userIds = (await this.client.eval(
      luaScript,
      2,
      targetsSetKey,
      targetZSetKey,
      targetKeyName,
      userId,
      nowMs.toString(),
      expiryMs.toString(),
    )) as string[];

    return userIds;
  }

  async stopTyping(
    targetId: string,
    isChannel: boolean,
    userId: string,
  ): Promise<string[]> {
    if (!this.client || !this.isConnected) return [];

    const targetKeyName = isChannel ? `chan:${targetId}` : `conv:${targetId}`;
    const targetsSetKey = this.k('typing:targets');
    const targetZSetKey = this.k(`typing:${targetKeyName}`);

    const nowMs = Date.now();

    const luaScript = `
      local targetsKey = KEYS[1]
      local zsetKey = KEYS[2]
      local target = ARGV[1]
      local userId = ARGV[2]
      local nowMs = tonumber(ARGV[3])

      redis.call('ZREM', zsetKey, userId)
      redis.call('ZREMRANGEBYSCORE', zsetKey, 0, nowMs)

      local remaining = redis.call('ZRANGEBYSCORE', zsetKey, nowMs, '+inf')
      if #remaining == 0 then
        redis.call('DEL', zsetKey)
        redis.call('SREM', targetsKey, target)
      end
      return remaining
    `;

    const userIds = (await this.client.eval(
      luaScript,
      2,
      targetsSetKey,
      targetZSetKey,
      targetKeyName,
      userId,
      nowMs.toString(),
    )) as string[];

    return userIds;
  }

  private startTypingSweeper(): void {
    this.typingSweeperTimer = setInterval(async () => {
      try {
        if (!this.client || !this.isConnected) return;
        await this.sweepTypingTargets();
      } catch (err: any) {
        this.logger.warn(`Lỗi typing sweeper: ${err.message}`);
      }
    }, 1000);
  }

  async sweepTypingTargets(): Promise<void> {
    if (!this.client || !this.isConnected) return;
    const targets = await this.client.smembers(this.k('typing:targets'));
    if (!targets || targets.length === 0) return;

    const nowMs = Date.now();
    const workerToken = `${this.instanceId}-${crypto.randomUUID()}`;

    for (const target of targets) {
      const lockKey = this.k(`lock:typing:sweeper:${target}`);
      const targetsKey = this.k('typing:targets');
      const zsetKey = this.k(`typing:${target}`);

      // Lua script with claim lock to ensure only 1 worker sweeps and broadcasts
      const luaScript = `
        local lockKey = KEYS[1]
        local targetsKey = KEYS[2]
        local zsetKey = KEYS[3]

        local workerToken = ARGV[1]
        local target = ARGV[2]
        local nowMs = tonumber(ARGV[3])

        local acquired = redis.call('SET', lockKey, workerToken, 'PX', 2000, 'NX')
        if not acquired then
          return {-1}
        end

        local expiredCount = redis.call('ZREMRANGEBYSCORE', zsetKey, 0, nowMs)
        local remaining = redis.call('ZRANGEBYSCORE', zsetKey, nowMs, '+inf')

        if #remaining == 0 then
          redis.call('DEL', zsetKey)
          redis.call('SREM', targetsKey, target)
        end

        return {expiredCount, remaining}
      `;

      try {
        const res = (await this.client.eval(
          luaScript,
          3,
          lockKey,
          targetsKey,
          zsetKey,
          workerToken,
          target,
          nowMs.toString(),
        )) as any[];

        if (!res || res[0] === -1) {
          // Lock held by another worker
          continue;
        }

        const expiredCount = res[0] as number;
        const remainingUsers = (res[1] || []) as string[];

        // Only broadcast if at least one user expired
        if (expiredCount > 0 && this.onTypingUpdateCallback) {
          const isChannel = target.startsWith('chan:');
          const targetId = target.slice(5);
          this.onTypingUpdateCallback({
            targetId,
            isChannel,
            userIds: remainingUsers,
          });
        }
      } catch (err: any) {
        this.logger.error(`Lỗi sweep typing cho ${target}: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Server Voice States Management (Realtime Voice Presence)
  // ---------------------------------------------------------------------------
  async setServerVoiceState(
    serverId: string,
    userId: string,
    state: VoiceMemberState,
  ): Promise<void> {
    if (!this.client || !this.isConnected) {
      if (!this.inMemoryVoiceStates.has(serverId)) {
        this.inMemoryVoiceStates.set(serverId, new Map());
      }
      this.inMemoryVoiceStates.get(serverId)!.set(userId, state);
      return;
    }

    const serverKey = this.k(`server:${serverId}:voice_states`);
    const userVoiceServersKey = this.k(`user:${userId}:voice_servers`);

    await this.client
      .multi()
      .hset(serverKey, userId, JSON.stringify(state))
      .sadd(userVoiceServersKey, serverId)
      .exec();
  }

  async removeServerVoiceState(
    serverId: string,
    userId: string,
  ): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      const serverMap = this.inMemoryVoiceStates.get(serverId);
      if (!serverMap) return null;
      const prev = serverMap.get(userId);
      serverMap.delete(userId);
      if (serverMap.size === 0) {
        this.inMemoryVoiceStates.delete(serverId);
      }
      return prev ? prev.channelId : null;
    }

    const serverKey = this.k(`server:${serverId}:voice_states`);
    const userVoiceServersKey = this.k(`user:${userId}:voice_servers`);

    const prevRaw = await this.client.hget(serverKey, userId);
    await this.client
      .multi()
      .hdel(serverKey, userId)
      .srem(userVoiceServersKey, serverId)
      .exec();

    if (!prevRaw) return null;
    try {
      const parsed = JSON.parse(prevRaw) as VoiceMemberState;
      return parsed.channelId;
    } catch {
      return null;
    }
  }

  async getServerVoiceStates(serverId: string): Promise<VoiceMemberState[]> {
    if (!this.client || !this.isConnected) {
      const serverMap = this.inMemoryVoiceStates.get(serverId);
      if (!serverMap) return [];
      return Array.from(serverMap.values());
    }

    const serverKey = this.k(`server:${serverId}:voice_states`);
    const all = await this.client.hgetall(serverKey);
    const result: VoiceMemberState[] = [];

    for (const raw of Object.values(all)) {
      try {
        result.push(JSON.parse(raw) as VoiceMemberState);
      } catch {}
    }
    return result;
  }

  async removeUserFromAllVoiceStates(
    userId: string,
  ): Promise<Array<{ serverId: string; channelId: string }>> {
    const affected: Array<{ serverId: string; channelId: string }> = [];

    if (!this.client || !this.isConnected) {
      for (const [serverId, map] of this.inMemoryVoiceStates.entries()) {
        const prev = map.get(userId);
        if (prev) {
          affected.push({ serverId, channelId: prev.channelId });
          map.delete(userId);
        }
      }
      return affected;
    }

    const userVoiceServersKey = this.k(`user:${userId}:voice_servers`);
    const serverIds = await this.client.smembers(userVoiceServersKey);

    for (const serverId of serverIds) {
      const serverKey = this.k(`server:${serverId}:voice_states`);
      const prevRaw = await this.client.hget(serverKey, userId);
      if (prevRaw) {
        try {
          const parsed = JSON.parse(prevRaw) as VoiceMemberState;
          affected.push({ serverId, channelId: parsed.channelId });
        } catch {}
      }
      await this.client.hdel(serverKey, userId);
    }

    await this.client.del(userVoiceServersKey);
    return affected;
  }

  // ---------------------------------------------------------------------------
  // Cleanup on Shutdown
  // ---------------------------------------------------------------------------
  async onModuleDestroy(): Promise<void> {
    await this.cleanup();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.deadInstanceSweeperTimer) clearInterval(this.deadInstanceSweeperTimer);
    if (this.offlineProcessorTimer) clearInterval(this.offlineProcessorTimer);
    if (this.typingSweeperTimer) clearInterval(this.typingSweeperTimer);

    if (this.client) {
      try {
        await this.client.srem(this.k('presence:instances'), this.instanceId);
        await this.client.del(this.k(`presence:instance:${this.instanceId}:heartbeat`));
        await this.client.del(this.k(`presence:instance:${this.instanceId}:users`));
        await this.client.quit();
      } catch {}
      this.client = null;
      this.isConnected = false;
    }
  }
}
