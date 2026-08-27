import { forwardRef, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Server, Socket } from 'socket.io';
import { normalizeCorsOrigins } from '../../common/utils/cors.util';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import {
  Room,
  type ClientToServerEvents,
  type JoinConversationResponse,
  type MessagePayload,
  type ServerToClientEvents,
  type VoiceMemberState,
  type VoiceServerStatesSyncPayload,
} from '../../shared/socket-events';
export { Room };
import { ConversationsService } from '../conversations/conversations.service';
import { ServerPermissionsService } from '../servers/server-permissions.service';
import { PresenceService } from './presence.service';
import { RedisStateService } from './redis-state.service';
import {
  CHAT_EVENTS,
  type ConversationDeletedEvent,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageHiddenForUserEvent,
  type MessageReadEvent,
  type MessageUpdatedEvent,
  type ReactionUpdatedEvent,
  type UserBlockCreatedEvent,
  type UserBlockRemovedEvent,
  type RelationshipInvalidatedEvent,
} from './constants/chat-events.constant';

interface SocketData {
  userId: string;
}

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: normalizeCorsOrigins(process.env.CORS_ORIGINS),
    credentials: true,
  },
})
export class ChatGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;

  /** Lưu danh sách userId đang gõ theo từng conversationId (In-memory fallback) */
  private readonly conversationTypingMap = new Map<string, Set<string>>();
  /** Lưu danh sách userId đang gõ theo từng channelId (In-memory fallback) */
  private readonly channelTypingMap = new Map<string, Set<string>>();
  /** Timer để tự clear typing khi user ngừng gõ mà không gửi typing:stop (In-memory fallback) */
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  /** Lưu mốc thời gian gõ gần nhất để throttle chống spam typing:start (ms) */
  private readonly userLastTypingAt = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conversationsService: ConversationsService,
    @Inject(forwardRef(() => ServerPermissionsService))
    private readonly serverPermissionsService: ServerPermissionsService,
    private readonly presenceService: PresenceService,
    private readonly redisState: RedisStateService,
  ) {}

  onModuleInit(): void {
    // 1. Lắng nghe cluster offline notifications từ PresenceService / RedisState
    this.presenceService.setClusterOfflineHandler((offlinePayload) => {
      for (const peerId of offlinePayload.peers) {
        this.server?.to(Room.user(peerId)).emit('presence:updated', {
          userId: offlinePayload.userId,
          status: 'offline',
          lastSeenAt: offlinePayload.lastSeenAt,
        });
      }
    });

    // 2. Lắng nghe cluster idle notifications từ PresenceService / RedisState
    this.presenceService.setClusterIdleHandler((idlePayload) => {
      for (const peerId of idlePayload.peers) {
        this.server?.to(Room.user(peerId)).emit('presence:updated', {
          userId: idlePayload.userId,
          status: 'idle',
          lastSeenAt: null,
        });
      }
    });

    // 3. Lắng nghe typing updates từ active typing sweeper
    this.redisState.setTypingUpdateCallback(
      ({ targetId, isChannel, userIds }) => {
        if (isChannel) {
          this.server
            ?.to(Room.channel(targetId))
            .emit('typing:updated', { channelId: targetId, userIds });
        } else {
          this.server
            ?.to(Room.conversation(targetId))
            .emit('typing:updated', { conversationId: targetId, userIds });
        }
      },
    );
  }

  /**
   * Namespace middleware chạy TRƯỚC KHI connection được chấp nhận.
   */
  afterInit(server: Server | Namespace): void {
    server.use(async (socket: Socket, next: (err?: Error) => void) => {
      try {
        const authHeader = socket.handshake.headers?.authorization;
        let rawToken: string | undefined = socket.handshake.auth?.token;
        if (!rawToken && typeof authHeader === 'string') {
          rawToken = authHeader;
        }

        let token: string | null = null;
        if (typeof rawToken === 'string') {
          const trimmed = rawToken.trim();
          token = trimmed.startsWith('Bearer ')
            ? trimmed.slice(7).trim()
            : trimmed;
        }

        if (!token) {
          this.logger.warn(`Từ chối kết nối socket ${socket.id}: thiếu token`);
          return next(new Error('Chưa xác thực'));
        }

        const { data: authData, error } =
          await this.supabase.client.auth.getUser(token);

        if (error || !authData?.user?.id) {
          this.logger.warn(
            `Từ chối kết nối socket ${socket.id}: token không hợp lệ (${error?.message})`,
          );
          return next(new Error('Chưa xác thực'));
        }

        socket.data.userId = authData.user.id;
        next();
      } catch (err) {
        this.logger.error(`Lỗi xác thực socket connection ${socket.id}:`, err);
        next(new Error('Chưa xác thực'));
      }
    });
  }

  /**
   * Chạy sau khi socket đã vượt qua middleware xác thực thành công.
   */
  async handleConnection(client: TypedSocket): Promise<void> {
    const userId = client.data.userId;
    if (!userId) {
      this.logger.warn(`Socket ${client.id} thiếu userId sau middleware`);
      client.disconnect(true);
      return;
    }

    // 1. Auto-join user room của chính họ
    await client.join(Room.user(userId));

    // 2. Ghi nhận socket vào PresenceService
    const connectResult = await this.presenceService.handleUserConnect(
      userId,
      client.id,
    );

    // 3. Nếu là socket đầu tiên kết nối trên cluster -> broadcast presence:updated tới toàn bộ peers
    if (connectResult.isFirstConnection) {
      for (const peerId of connectResult.peers) {
        this.server.to(Room.user(peerId)).emit('presence:updated', {
          userId,
          status: connectResult.status,
          lastSeenAt: null,
        });
      }
    }

    // 4. Gửi initial snapshot về trạng thái của toàn bộ peers cho client mới kết nối
    const snapshot = await this.presenceService.getPeersSnapshot(userId);
    client.emit('presence:sync', { presences: snapshot });

    this.logger.log(
      `Socket ${client.id} xác thực thành công cho user ${userId} (status: ${connectResult.status})`,
    );
  }

  async handleDisconnect(client: TypedSocket): Promise<void> {
    const userId = client.data.userId;
    if (userId) {
      this.clearUserTyping(userId);

      // Xử lý ngắt kết nối với grace period 15s
      await this.presenceService.handleUserDisconnect(
        client.id,
        (offlinePayload) => {
          for (const peerId of offlinePayload.peers) {
            this.server.to(Room.user(peerId)).emit('presence:updated', {
              userId: offlinePayload.userId,
              status: 'offline',
              lastSeenAt: offlinePayload.lastSeenAt,
            });
          }
        },
      );

      // Tự động dọn dẹp voice states nếu user ngắt kết nối
      const affectedServers =
        await this.redisState.removeUserFromAllVoiceStates(userId);
      for (const item of affectedServers) {
        this.server.to(Room.server(item.serverId)).emit('voice:state-updated', {
          serverId: item.serverId,
          channelId: item.channelId,
          userId,
          state: null,
        });
      }

      this.logger.log(`Socket ${client.id} (user ${userId}) đã ngắt kết nối`);
    }
  }

  @SubscribeMessage('presence:activity')
  async handlePresenceActivity(client: TypedSocket): Promise<void> {
    const broadcastPayload = await this.presenceService.handleUserActivity(
      client.id,
    );
    if (broadcastPayload) {
      for (const peerId of broadcastPayload.peers) {
        this.server.to(Room.user(peerId)).emit('presence:updated', {
          userId: broadcastPayload.userId,
          status: broadcastPayload.status,
          lastSeenAt: null,
        });
      }
    }
  }

  @SubscribeMessage('presence:get-snapshot')
  async handleGetPresenceSnapshot(
    client: TypedSocket,
  ): Promise<{
    presences: Record<string, { status: any; lastSeenAt: string | null }>;
  }> {
    const userId = client.data.userId;
    if (!userId) {
      return { presences: {} };
    }
    const presences = await this.presenceService.getPeersSnapshot(userId);
    return { presences };
  }

  // ---------------------------------------------------------------------------
  // Conversation Room Handlers
  // ---------------------------------------------------------------------------

  @SubscribeMessage('conversation:join')
  async handleConversationJoin(
    client: TypedSocket,
    payload: { conversationId: string },
  ): Promise<JoinConversationResponse> {
    const userId = client.data.userId;
    if (!userId) {
      return { success: false, error: 'Chưa xác thực', status: 'rejected' };
    }

    if (!isValidUuid(payload?.conversationId)) {
      return {
        success: false,
        error: 'conversationId không hợp lệ (phải là UUID hợp lệ)',
        status: 'rejected',
      };
    }

    const isMember = await this.conversationsService.verifyMembership(
      userId,
      payload.conversationId,
    );

    if (!isMember) {
      this.logger.warn(
        `User ${userId} cố join conversation ${payload.conversationId} không thuộc quyền`,
      );
      return {
        success: false,
        error: 'Không có quyền truy cập cuộc trò chuyện',
        status: 'rejected',
      };
    }

    await client.join(Room.conversation(payload.conversationId));
    return { success: true, status: 'joined' };
  }

  @SubscribeMessage('conversation:leave')
  async handleConversationLeave(
    client: TypedSocket,
    payload: { conversationId: string },
  ): Promise<{ success: boolean }> {
    if (isValidUuid(payload?.conversationId)) {
      await client.leave(Room.conversation(payload.conversationId));
      if (client.data.userId) {
        await this.removeTyping(
          payload.conversationId,
          client.data.userId,
          false,
        );
      }
    }
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Server Channel Room Handlers
  // ---------------------------------------------------------------------------

  @SubscribeMessage('channel:join')
  async handleChannelJoin(
    client: TypedSocket,
    payload: { channelId: string },
  ): Promise<JoinConversationResponse> {
    const userId = client.data.userId;
    if (!userId) {
      return { success: false, error: 'Chưa xác thực', status: 'rejected' };
    }

    if (!isValidUuid(payload?.channelId)) {
      return {
        success: false,
        error: 'channelId không hợp lệ (phải là UUID hợp lệ)',
        status: 'rejected',
      };
    }

    try {
      await this.serverPermissionsService.assertChannelView(
        userId,
        payload.channelId,
      );
    } catch (err: any) {
      this.logger.warn(
        `User ${userId} cố join channel room ${payload.channelId} nhưng thiếu quyền VIEW_CHANNEL`,
      );
      return {
        success: false,
        error: 'Không có quyền xem kênh này',
        status: 'rejected',
      };
    }

    await client.join(Room.channel(payload.channelId));
    return { success: true, status: 'joined' };
  }

  @SubscribeMessage('channel:leave')
  async handleChannelLeave(
    client: TypedSocket,
    payload: { channelId: string },
  ): Promise<{ success: boolean }> {
    if (isValidUuid(payload?.channelId)) {
      await client.leave(Room.channel(payload.channelId));
      if (client.data.userId) {
        await this.removeTyping(payload.channelId, client.data.userId, true);
      }
    }
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Server Room Handlers
  // ---------------------------------------------------------------------------

  @SubscribeMessage('server:join')
  async handleServerJoin(
    client: TypedSocket,
    payload: { serverId: string },
  ): Promise<{ success: boolean; error?: string }> {
    const userId = client.data.userId;
    if (!userId) {
      return { success: false, error: 'Chưa xác thực' };
    }

    if (!isValidUuid(payload?.serverId)) {
      return { success: false, error: 'serverId không hợp lệ' };
    }

    const { data: member, error } = await this.supabase.client
      .from('server_members')
      .select('server_id')
      .eq('server_id', payload.serverId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !member) {
      this.logger.warn(
        `User ${userId} cố join server room ${payload?.serverId} nhưng không phải member`,
      );
      return { success: false, error: 'Không có quyền truy cập máy chủ' };
    }

    await client.join(Room.server(payload.serverId));
    return { success: true };
  }

  @SubscribeMessage('server:leave')
  async handleServerLeave(
    client: TypedSocket,
    payload: { serverId: string },
  ): Promise<{ success: boolean }> {
    if (isValidUuid(payload?.serverId)) {
      await client.leave(Room.server(payload.serverId));
    }
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Server Voice States Handlers (Realtime Voice Presence)
  // ---------------------------------------------------------------------------

  @SubscribeMessage('voice:state-update')
  async handleVoiceStateUpdate(
    client: TypedSocket,
    payload: {
      serverId: string;
      channelId: string | null;
      isMuted?: boolean;
      isDeafened?: boolean;
      isCameraOn?: boolean;
      isScreenSharing?: boolean;
    },
  ): Promise<void> {
    const userId = client.data.userId;
    if (!userId || !isValidUuid(payload?.serverId)) return;

    if (payload.channelId === null) {
      // User rời khỏi kênh voice trong server
      const prevChannelId = await this.redisState.removeServerVoiceState(
        payload.serverId,
        userId,
      );
      this.server
        .to(Room.server(payload.serverId))
        .emit('voice:state-updated', {
          serverId: payload.serverId,
          channelId: prevChannelId,
          userId,
          state: null,
        });
      return;
    }

    if (!isValidUuid(payload.channelId)) return;

    // Kiểm tra quyền xem kênh voice
    try {
      await this.serverPermissionsService.assertChannelView(
        userId,
        payload.channelId,
      );
    } catch {
      return;
    }

    // Lấy thông tin user profile
    const { data: profile } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('id', userId)
      .maybeSingle();

    const displayName =
      profile?.display_name || profile?.username || 'Nexus Member';
    const username = profile?.username || 'nexus_member';
    const avatarUrl = profile?.avatar_url || null;

    const voiceState: VoiceMemberState = {
      userId,
      channelId: payload.channelId,
      serverId: payload.serverId,
      name: displayName,
      username,
      displayName,
      avatarUrl,
      isMuted: payload.isMuted ?? false,
      isDeafened: payload.isDeafened ?? false,
      isCameraOn: payload.isCameraOn ?? false,
      isScreenSharing: payload.isScreenSharing ?? false,
      joinedAt: new Date().toISOString(),
    };

    await this.redisState.setServerVoiceState(
      payload.serverId,
      userId,
      voiceState,
    );

    this.server.to(Room.server(payload.serverId)).emit('voice:state-updated', {
      serverId: payload.serverId,
      channelId: payload.channelId,
      userId,
      state: voiceState,
    });
  }

  @SubscribeMessage('voice:get-server-states')
  async handleGetServerVoiceStates(
    client: TypedSocket,
    payload: { serverId: string },
  ): Promise<VoiceServerStatesSyncPayload> {
    if (!isValidUuid(payload?.serverId)) {
      return { serverId: payload?.serverId || '', states: [] };
    }

    const states = await this.redisState.getServerVoiceStates(payload.serverId);
    return {
      serverId: payload.serverId,
      states,
    };
  }

  @SubscribeMessage('voice:move-member')
  async handleVoiceMoveMember(
    client: TypedSocket,
    payload: {
      serverId: string;
      targetUserId: string;
      targetChannelId: string;
    },
  ): Promise<void> {
    const userId = client.data.userId;
    if (
      !userId ||
      !isValidUuid(payload?.serverId) ||
      !isValidUuid(payload?.targetUserId) ||
      !isValidUuid(payload?.targetChannelId)
    ) {
      return;
    }

    try {
      const caps = await this.serverPermissionsService.getCapabilities(
        userId,
        payload.serverId,
      );
      if (!caps.isOwner && !caps.canManageServer && !caps.canManageChannels) {
        this.logger.warn(
          `User ${userId} không có quyền di chuyển voice member`,
        );
        return;
      }

      // Lấy thông tin kênh đích
      const { data: targetChannel } = await this.supabase.client
        .from('channels')
        .select('id, name, type')
        .eq('id', payload.targetChannelId)
        .eq('server_id', payload.serverId)
        .maybeSingle();

      if (!targetChannel || targetChannel.type !== 'voice') {
        return;
      }

      // Gửi event chỉ thị chuyển kênh tới target user
      this.server.to(Room.user(payload.targetUserId)).emit('voice:force-move', {
        serverId: payload.serverId,
        channelId: targetChannel.id,
        channelName: targetChannel.name,
      });

      this.logger.log(
        `Chủ server ${userId} đã chuyển user ${payload.targetUserId} sang kênh thoại ${targetChannel.name} (${targetChannel.id})`,
      );
    } catch (err) {
      this.logger.error(`Lỗi khi di chuyển voice member:`, err);
    }
  }

  @SubscribeMessage('voice:kick-member')
  async handleVoiceKickMember(
    client: TypedSocket,
    payload: {
      serverId: string;
      targetUserId: string;
    },
  ): Promise<void> {
    const userId = client.data.userId;
    if (
      !userId ||
      !isValidUuid(payload?.serverId) ||
      !isValidUuid(payload?.targetUserId)
    ) {
      return;
    }

    try {
      const caps = await this.serverPermissionsService.getCapabilities(
        userId,
        payload.serverId,
      );
      if (!caps.isOwner && !caps.canManageServer && !caps.canManageChannels) {
        this.logger.warn(`User ${userId} không có quyền kick voice member`);
        return;
      }

      // Gửi event chỉ thị ngắt kết nối voice tới target user
      this.server
        .to(Room.user(payload.targetUserId))
        .emit('voice:force-disconnect', {
          serverId: payload.serverId,
        });

      // Xóa khỏi redis state và broadcast update
      const prevChannelId = await this.redisState.removeServerVoiceState(
        payload.serverId,
        payload.targetUserId,
      );

      this.server
        .to(Room.server(payload.serverId))
        .emit('voice:state-updated', {
          serverId: payload.serverId,
          channelId: prevChannelId,
          userId: payload.targetUserId,
          state: null,
        });

      this.logger.log(
        `Chủ server ${userId} đã ngắt kết nối voice user ${payload.targetUserId}`,
      );
    } catch (err) {
      this.logger.error(`Lỗi khi kick voice member:`, err);
    }
  }

  @SubscribeMessage('voice:server-mute-member')
  async handleVoiceServerMuteMember(
    client: TypedSocket,
    payload: {
      serverId: string;
      targetUserId: string;
      isMuted: boolean;
    },
  ): Promise<void> {
    const userId = client.data.userId;
    if (
      !userId ||
      !isValidUuid(payload?.serverId) ||
      !isValidUuid(payload?.targetUserId)
    ) {
      return;
    }

    try {
      const caps = await this.serverPermissionsService.getCapabilities(
        userId,
        payload.serverId,
      );
      if (!caps.isOwner && !caps.canManageServer && !caps.canManageChannels) {
        return;
      }

      // Gửi event chỉ thị bật/tắt mic tới target user
      this.server.to(Room.user(payload.targetUserId)).emit('voice:force-mute', {
        serverId: payload.serverId,
        isMuted: payload.isMuted,
      });

      // Cập nhật trạng thái voice trong Redis nếu đang có
      const serverStates = await this.redisState.getServerVoiceStates(
        payload.serverId,
      );
      const targetState = serverStates.find(
        (s) => s.userId === payload.targetUserId,
      );
      if (targetState) {
        const updatedState: VoiceMemberState = {
          ...targetState,
          isMuted: payload.isMuted,
        };
        await this.redisState.setServerVoiceState(
          payload.serverId,
          payload.targetUserId,
          updatedState,
        );
        this.server
          .to(Room.server(payload.serverId))
          .emit('voice:state-updated', {
            serverId: payload.serverId,
            channelId: targetState.channelId,
            userId: payload.targetUserId,
            state: updatedState,
          });
      }
    } catch (err) {
      this.logger.error(`Lỗi khi server-mute voice member:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Typing Indicators (Conversation & Channel)
  // ---------------------------------------------------------------------------

  @SubscribeMessage('typing:start')
  async handleTypingStart(
    client: TypedSocket,
    payload: { conversationId?: string; channelId?: string },
  ): Promise<void> {
    const userId = client.data.userId;
    if (!userId) return;

    if (payload?.conversationId && isValidUuid(payload.conversationId)) {
      const isMember = await this.conversationsService.verifyMembership(
        userId,
        payload.conversationId,
      );
      if (!isMember) return;

      const throttleKey = `conv:${payload.conversationId}:${userId}`;
      const now = Date.now();
      const lastTyping = this.userLastTypingAt.get(throttleKey) ?? 0;
      if (now - lastTyping < 1500) {
        if (!this.redisState.isDistributedActive()) {
          this.refreshTypingTimer(payload.conversationId, userId, false);
        }
        return;
      }
      this.userLastTypingAt.set(throttleKey, now);
      await this.addTyping(payload.conversationId, userId, false);
    } else if (payload?.channelId && isValidUuid(payload.channelId)) {
      try {
        await this.serverPermissionsService.assertChannelSend(
          userId,
          payload.channelId,
        );
      } catch {
        return;
      }

      const throttleKey = `chan:${payload.channelId}:${userId}`;
      const now = Date.now();
      const lastTyping = this.userLastTypingAt.get(throttleKey) ?? 0;
      if (now - lastTyping < 1500) {
        if (!this.redisState.isDistributedActive()) {
          this.refreshTypingTimer(payload.channelId, userId, true);
        }
        return;
      }
      this.userLastTypingAt.set(throttleKey, now);
      await this.addTyping(payload.channelId, userId, true);
    }
  }

  @SubscribeMessage('typing:stop')
  async handleTypingStop(
    client: TypedSocket,
    payload: { conversationId?: string; channelId?: string },
  ): Promise<void> {
    const userId = client.data.userId;
    if (!userId) return;

    if (payload?.conversationId && isValidUuid(payload.conversationId)) {
      await this.removeTyping(payload.conversationId, userId, false);
    } else if (payload?.channelId && isValidUuid(payload.channelId)) {
      await this.removeTyping(payload.channelId, userId, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Domain Event Handlers
  // ---------------------------------------------------------------------------

  @OnEvent(CHAT_EVENTS.MESSAGE_CREATED)
  async handleMessageCreated(event: MessageCreatedEvent): Promise<void> {
    const { conversationId, channelId, message } = event;
    this.logger.log(
      `[ChatGateway] handleMessageCreated: conversationId=${conversationId}, channelId=${channelId}, msgId=${message?.id}`,
    );

    if (conversationId) {
      // Broadcast tới conversation room
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:created', { message });

      // Emit notification tới user room của participants khác
      const participantIds =
        await this.conversationsService.getParticipantIds(conversationId);
      const preview = message.content
        ? message.content.length > 100
          ? message.content.slice(0, 100) + '…'
          : message.content
        : null;

      for (const participantId of participantIds) {
        if (participantId === message.authorId) continue;
        this.server?.to(Room.user(participantId)).emit('conversation:updated', {
          conversationId,
          senderId: message.authorId ?? '',
          lastMessageId: message.id,
          lastMessagePreview: preview,
          lastMessageAt: message.createdAt,
          unreadDelta: 1,
        });
      }
    } else if (channelId) {
      // Broadcast tới channel room
      this.server
        ?.to(Room.channel(channelId))
        .emit('message:created', { message });
    }
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_UPDATED)
  handleMessageUpdated(event: MessageUpdatedEvent): void {
    const { conversationId, channelId, message } = event;
    if (conversationId) {
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:updated', { message });
    } else if (channelId) {
      this.server
        ?.to(Room.channel(channelId))
        .emit('message:updated', { message });
    }
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_PIN_UPDATED)
  handleMessagePinUpdated(event: {
    channelId?: string | null;
    conversationId?: string | null;
    message: MessagePayload;
    pinned: boolean;
  }): void {
    const { channelId, conversationId, message, pinned } = event;
    if (channelId) {
      this.server
        ?.to(Room.channel(channelId))
        .emit('message:pin-updated', {
          channelId,
          conversationId: null,
          message,
          pinned,
        });
    } else if (conversationId) {
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:pin-updated', {
          channelId: null,
          conversationId,
          message,
          pinned,
        });
    }
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_DELETED)
  handleMessageDeleted(event: MessageDeletedEvent): void {
    const { conversationId, channelId, messageId } = event;
    if (conversationId) {
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:deleted', {
          channelId: null,
          conversationId,
          messageId,
        });
    } else if (channelId) {
      this.server?.to(Room.channel(channelId)).emit('message:deleted', {
        channelId,
        conversationId: null,
        messageId,
      });
    }
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_HIDDEN_FOR_USER)
  handleMessageHiddenForUser(event: MessageHiddenForUserEvent): void {
    const { userId, messageId, conversationId, channelId } = event;
    // CHỈ emit tới Room riêng của user đó: Room.user(userId)
    // Tuyệt đối KHÔNG emit vào room conversation hay channel!
    this.server?.to(Room.user(userId)).emit('message:hidden-for-user', {
      messageId,
      userId,
      conversationId: conversationId ?? null,
      channelId: channelId ?? null,
      hiddenAt: new Date().toISOString(),
    });
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_READ)
  handleMessageRead(event: MessageReadEvent): void {
    const { conversationId, channelId, userId, lastReadMessageId } = event;
    if (conversationId) {
      this.server?.to(Room.conversation(conversationId)).emit('message:read', {
        conversationId,
        userId,
        lastReadMessageId,
      });
    } else if (channelId) {
      this.server?.to(Room.channel(channelId)).emit('message:read', {
        channelId,
        userId,
        lastReadMessageId,
      });
    }
  }

  @OnEvent(CHAT_EVENTS.CONVERSATION_DELETED)
  handleConversationDeleted(event: ConversationDeletedEvent): void {
    const { conversationId, userId, friendId } = event;
    this.server?.to(Room.user(userId)).emit('conversation:deleted', {
      conversationId,
      friendId,
    });
    this.server?.to(Room.user(friendId)).emit('conversation:deleted', {
      conversationId,
      friendId: userId,
    });
  }

  @OnEvent(CHAT_EVENTS.REACTION_UPDATED)
  handleReactionUpdated(event: ReactionUpdatedEvent): void {
    const {
      conversationId,
      channelId,
      messageId,
      actorUserId,
      emoji,
      action,
      clientMutationId,
      reactions,
    } = event;

    const payload = {
      messageId,
      conversationId: conversationId ?? null,
      channelId: channelId ?? null,
      actorUserId,
      emoji,
      action,
      clientMutationId,
      reactions,
    };

    if (conversationId) {
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:reaction-updated', payload);
    } else if (channelId) {
      this.server
        ?.to(Room.channel(channelId))
        .emit('message:reaction-updated', payload);
    }
  }

  @OnEvent(CHAT_EVENTS.USER_BLOCK_CREATED)
  handleUserBlockCreated(event: UserBlockCreatedEvent): void {
    const { blockerId, blockedUser } = event;
    this.server
      ?.to(Room.user(blockerId))
      .emit('user:block-created', blockedUser);
  }

  @OnEvent(CHAT_EVENTS.USER_BLOCK_REMOVED)
  handleUserBlockRemoved(event: UserBlockRemovedEvent): void {
    const { blockerId, blockedUserId } = event;
    this.server
      ?.to(Room.user(blockerId))
      .emit('user:block-removed', { userId: blockedUserId });
  }

  @OnEvent(CHAT_EVENTS.RELATIONSHIP_INVALIDATED)
  handleRelationshipInvalidated(event: RelationshipInvalidatedEvent): void {
    const { targetUserId, invalidatedWithUserId } = event;
    this.server?.to(Room.user(targetUserId)).emit('relationship:invalidated', {
      userId: invalidatedWithUserId,
    });
  }

  // ---------------------------------------------------------------------------
  // Typing state management helper
  // ---------------------------------------------------------------------------

  private async addTyping(
    targetId: string,
    userId: string,
    isChannel: boolean,
  ): Promise<void> {
    if (this.redisState.isDistributedActive()) {
      const userIds = await this.redisState.startTyping(
        targetId,
        isChannel,
        userId,
      );
      this.broadcastTypingUserIds(targetId, isChannel, userIds);
      return;
    }

    const map = isChannel ? this.channelTypingMap : this.conversationTypingMap;
    let users = map.get(targetId);
    if (!users) {
      users = new Set<string>();
      map.set(targetId, users);
    }

    users.add(userId);
    this.broadcastTypingUpdate(targetId, isChannel);
    this.refreshTypingTimer(targetId, userId, isChannel);
  }

  private refreshTypingTimer(
    targetId: string,
    userId: string,
    isChannel: boolean,
  ): void {
    const timerKey = `${isChannel ? 'chan' : 'conv'}:${targetId}:${userId}`;
    const oldTimer = this.typingTimers.get(timerKey);
    if (oldTimer) {
      clearTimeout(oldTimer);
    }

    const timer = setTimeout(() => {
      void this.removeTyping(targetId, userId, isChannel);
    }, 5000);

    this.typingTimers.set(timerKey, timer);
  }

  private async removeTyping(
    targetId: string,
    userId: string,
    isChannel: boolean,
  ): Promise<void> {
    if (this.redisState.isDistributedActive()) {
      const userIds = await this.redisState.stopTyping(
        targetId,
        isChannel,
        userId,
      );
      this.broadcastTypingUserIds(targetId, isChannel, userIds);
      return;
    }

    const map = isChannel ? this.channelTypingMap : this.conversationTypingMap;
    const users = map.get(targetId);
    if (users && users.has(userId)) {
      users.delete(userId);
      if (users.size === 0) {
        map.delete(targetId);
      }
      this.broadcastTypingUpdate(targetId, isChannel);
    }

    const timerKey = `${isChannel ? 'chan' : 'conv'}:${targetId}:${userId}`;
    const timer = this.typingTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(timerKey);
    }
    this.userLastTypingAt.delete(timerKey);
  }

  private clearUserTyping(userId: string): void {
    const affectedConvs: string[] = [];
    const affectedChans: string[] = [];

    for (const [convId, users] of this.conversationTypingMap.entries()) {
      if (users.has(userId)) {
        users.delete(userId);
        if (users.size === 0) {
          this.conversationTypingMap.delete(convId);
        }
        affectedConvs.push(convId);
      }
    }

    for (const [chanId, users] of this.channelTypingMap.entries()) {
      if (users.has(userId)) {
        users.delete(userId);
        if (users.size === 0) {
          this.channelTypingMap.delete(chanId);
        }
        affectedChans.push(chanId);
      }
    }

    for (const [key, timer] of this.typingTimers.entries()) {
      if (key.endsWith(`:${userId}`)) {
        clearTimeout(timer);
        this.typingTimers.delete(key);
        this.userLastTypingAt.delete(key);
      }
    }

    for (const convId of affectedConvs) {
      this.broadcastTypingUpdate(convId, false);
    }
    for (const chanId of affectedChans) {
      this.broadcastTypingUpdate(chanId, true);
    }
  }

  private broadcastTypingUserIds(
    targetId: string,
    isChannel: boolean,
    userIds: string[],
  ): void {
    if (isChannel) {
      this.server
        ?.to(Room.channel(targetId))
        .emit('typing:updated', { channelId: targetId, userIds });
    } else {
      this.server
        ?.to(Room.conversation(targetId))
        .emit('typing:updated', { conversationId: targetId, userIds });
    }
  }

  private broadcastTypingUpdate(targetId: string, isChannel: boolean): void {
    const map = isChannel ? this.channelTypingMap : this.conversationTypingMap;
    const users = map.get(targetId);
    const userIds = users ? Array.from(users) : [];
    this.broadcastTypingUserIds(targetId, isChannel, userIds);
  }

  /**
   * Phát sự kiện server:channels-invalidated vào Room.server(serverId)
   * Tuyệt đối không broadcast channel DTO vào room chung để chống rò rỉ metadata kênh riêng tư.
   */
  emitChannelsInvalidated(serverId: string): void {
    if (!this.server) return;
    this.server.to(Room.server(serverId)).emit('server:channels-invalidated', {
      serverId,
    });
  }

  emitInvitationReceived(inviteeId: string, invitation: any): void {
    if (!this.server) return;
    this.server.to(Room.user(inviteeId)).emit('server:invitation-received', {
      invitation,
    });
  }

  emitInvitationUpdated(
    inviterId: string,
    inviteeId: string,
    payload: {
      invitationId: string;
      serverId: string;
      inviteeId: string;
      status: 'accepted' | 'declined' | 'revoked' | 'expired';
    },
  ): void {
    if (!this.server) return;
    this.server
      .to(Room.user(inviterId))
      .emit('server:invitation-updated', payload);
    this.server
      .to(Room.user(inviteeId))
      .emit('server:invitation-updated', payload);
  }

  emitCapabilitiesUpdated(
    serverId: string,
    userId: string,
    capabilities: any,
  ): void {
    if (!this.server) return;
    this.server.to(Room.user(userId)).emit('server:capabilities-updated', {
      serverId,
      capabilities,
    });
  }

  emitServerDeleted(serverId: string): void {
    if (!this.server) return;
    this.server.to(Room.server(serverId)).emit('server:deleted', { serverId });
  }

  emitServerMemberLeft(serverId: string, userId: string): void {
    if (!this.server) return;
    this.server
      .to(Room.server(serverId))
      .emit('server:member-left', { serverId, userId });
    this.server.to(Room.user(userId)).emit('server:deleted', { serverId });
  }
}
