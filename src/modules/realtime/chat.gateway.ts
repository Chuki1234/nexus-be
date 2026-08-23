import { Logger } from '@nestjs/common';
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
  type ServerToClientEvents,
} from '../../shared/socket-events';
import { ConversationsService } from '../conversations/conversations.service';
import { PresenceService } from './presence.service';
import {
  CHAT_EVENTS,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageReadEvent,
  type MessageUpdatedEvent,
  type ReactionUpdatedEvent,
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
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;

  /** Lưu danh sách userId đang gõ theo từng conversationId */
  private readonly conversationTypingMap = new Map<string, Set<string>>();
  /** Timer để tự clear typing khi user ngừng gõ mà không gửi typing:stop */
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  /** Lưu mốc thời gian gõ gần nhất để throttle chống spam typing:start (ms) */
  private readonly userLastTypingAt = new Map<string, number>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conversationsService: ConversationsService,
    private readonly presenceService: PresenceService,
  ) {}

  /**
   * Namespace middleware chạy TRƯỚC KHI connection được chấp nhận.
   * Đảm bảo socket.data.userId đã được gán xong trước khi emit 'connect' cho client hoặc gọi handlers.
   * Token sai/hết hạn lập tức gây connect_error, ngăn ngừa race condition hoàn toàn.
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
          token = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
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
   * socket.data.userId được đảm bảo tồn tại 100%.
   */
  async handleConnection(client: TypedSocket): Promise<void> {
    const userId = client.data.userId;
    if (!userId) {
      this.logger.warn(`Socket ${client.id} thiếu userId sau middleware`);
      client.disconnect(true);
      return;
    }

    // 1. Auto-join user room của chính họ (dùng cho direct notification và presence)
    await client.join(Room.user(userId));

    // 2. Ghi nhận socket vào PresenceService
    const connectResult = await this.presenceService.handleUserConnect(
      userId,
      client.id,
    );

    // 3. Nếu là socket đầu tiên kết nối -> broadcast presence:updated tới toàn bộ peers
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

  handleDisconnect(client: TypedSocket): void {
    const userId = client.data.userId;
    if (userId) {
      this.clearUserTyping(userId);

      // Xử lý ngắt kết nối với grace period 15s
      this.presenceService.handleUserDisconnect(client.id, (offlinePayload) => {
        for (const peerId of offlinePayload.peers) {
          this.server.to(Room.user(peerId)).emit('presence:updated', {
            userId: offlinePayload.userId,
            status: 'offline',
            lastSeenAt: offlinePayload.lastSeenAt,
          });
        }
      });

      this.logger.log(`Socket ${client.id} (user ${userId}) đã ngắt kết nối`);
    }
  }

  @SubscribeMessage('presence:get-snapshot')
  async handleGetPresenceSnapshot(
    client: TypedSocket,
  ): Promise<{ presences: Record<string, { status: any; lastSeenAt: string | null }> }> {
    const userId = client.data.userId;
    if (!userId) {
      return { presences: {} };
    }
    const presences = await this.presenceService.getPeersSnapshot(userId);
    return { presences };
  }

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
        this.removeTyping(payload.conversationId, client.data.userId);
      }
    }
    return { success: true };
  }

  @SubscribeMessage('typing:start')
  async handleTypingStart(
    client: TypedSocket,
    payload: { conversationId: string },
  ): Promise<void> {
    const userId = client.data.userId;
    if (!userId) return;

    if (!isValidUuid(payload?.conversationId)) return;

    const conversationId = payload.conversationId;

    const isMember = await this.conversationsService.verifyMembership(
      userId,
      conversationId,
    );
    if (!isMember) return;

    // Throttle cơ bản: không broadcast nếu vừa gửi typing trong 1.5s gần đây
    const throttleKey = `${conversationId}:${userId}`;
    const now = Date.now();
    const lastTyping = this.userLastTypingAt.get(throttleKey) ?? 0;
    if (now - lastTyping < 1500) {
      // Chỉ gia hạn timer tự clear mà không spam broadcast
      this.refreshTypingTimer(conversationId, userId);
      return;
    }
    this.userLastTypingAt.set(throttleKey, now);

    this.addTyping(conversationId, userId);
  }

  @SubscribeMessage('typing:stop')
  handleTypingStop(
    client: TypedSocket,
    payload: { conversationId: string },
  ): void {
    const userId = client.data.userId;
    if (!userId) return;

    if (!isValidUuid(payload?.conversationId)) return;

    this.removeTyping(payload.conversationId, userId);
  }

  // ---------------------------------------------------------------------------
  // Domain Event Handlers (phát từ MessagesService khi ghi DB thành công)
  // ---------------------------------------------------------------------------

  @OnEvent(CHAT_EVENTS.MESSAGE_CREATED)
  async handleMessageCreated(event: MessageCreatedEvent): Promise<void> {
    const { conversationId, message } = event;
    if (!conversationId) return;

    // 1. Emit full message tới conversation room (existing behavior)
    this.server?.to(Room.conversation(conversationId)).emit('message:created', { message });

    // 2. Emit lightweight notification tới user room của participants khác (không sender)
    const participantIds = await this.conversationsService.getParticipantIds(conversationId);

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
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_UPDATED)
  handleMessageUpdated(event: MessageUpdatedEvent): void {
    const { conversationId, message } = event;
    if (conversationId) {
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:updated', { message });
    }
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_DELETED)
  handleMessageDeleted(event: MessageDeletedEvent): void {
    const { conversationId, channelId, messageId } = event;
    if (conversationId) {
      this.server?.to(Room.conversation(conversationId)).emit('message:deleted', {
        channelId: null,
        conversationId,
        messageId,
      });
    }
  }

  @OnEvent(CHAT_EVENTS.MESSAGE_READ)
  handleMessageRead(event: MessageReadEvent): void {
    const { conversationId, userId, lastReadMessageId } = event;
    this.server?.to(Room.conversation(conversationId)).emit('message:read', {
      conversationId,
      userId,
      lastReadMessageId,
    });
  }

  @OnEvent(CHAT_EVENTS.REACTION_UPDATED)
  handleReactionUpdated(event: ReactionUpdatedEvent): void {
    const {
      conversationId,
      messageId,
      actorUserId,
      emoji,
      action,
      clientMutationId,
      reactions,
    } = event;
    if (conversationId) {
      this.server
        ?.to(Room.conversation(conversationId))
        .emit('message:reaction-updated', {
          messageId,
          conversationId,
          actorUserId,
          emoji,
          action,
          clientMutationId,
          reactions,
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Typing state management helper
  // ---------------------------------------------------------------------------

  private addTyping(conversationId: string, userId: string): void {
    let users = this.conversationTypingMap.get(conversationId);
    if (!users) {
      users = new Set<string>();
      this.conversationTypingMap.set(conversationId, users);
    }

    users.add(userId);
    this.broadcastTypingUpdate(conversationId);
    this.refreshTypingTimer(conversationId, userId);
  }

  private refreshTypingTimer(conversationId: string, userId: string): void {
    const timerKey = `${conversationId}:${userId}`;
    const oldTimer = this.typingTimers.get(timerKey);
    if (oldTimer) {
      clearTimeout(oldTimer);
    }

    const timer = setTimeout(() => {
      this.removeTyping(conversationId, userId);
    }, 5000);

    this.typingTimers.set(timerKey, timer);
  }

  private removeTyping(conversationId: string, userId: string): void {
    const users = this.conversationTypingMap.get(conversationId);
    if (users && users.has(userId)) {
      users.delete(userId);
      if (users.size === 0) {
        this.conversationTypingMap.delete(conversationId);
      }
      this.broadcastTypingUpdate(conversationId);
    }

    const timerKey = `${conversationId}:${userId}`;
    const timer = this.typingTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(timerKey);
    }
    this.userLastTypingAt.delete(timerKey);
  }

  private clearUserTyping(userId: string): void {
    const affectedConversations: string[] = [];

    for (const [convId, users] of this.conversationTypingMap.entries()) {
      if (users.has(userId)) {
        users.delete(userId);
        if (users.size === 0) {
          this.conversationTypingMap.delete(convId);
        }
        affectedConversations.push(convId);
      }
    }

    // Clear tất cả timer của user
    for (const [key, timer] of this.typingTimers.entries()) {
      if (key.endsWith(`:${userId}`)) {
        clearTimeout(timer);
        this.typingTimers.delete(key);
        this.userLastTypingAt.delete(key);
      }
    }

    for (const convId of affectedConversations) {
      this.broadcastTypingUpdate(convId);
    }
  }

  private broadcastTypingUpdate(conversationId: string): void {
    const users = this.conversationTypingMap.get(conversationId);
    const userIds = users ? Array.from(users) : [];

    const payload = { conversationId, userIds };
    this.server
      ?.to(Room.conversation(conversationId))
      .emit('typing:updated', payload);
  }
}
