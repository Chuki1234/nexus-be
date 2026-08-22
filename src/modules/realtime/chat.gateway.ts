import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { normalizeCorsOrigins } from '../../common/utils/cors.util';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import {
  Room,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '../../shared/socket-events';
import { ConversationsService } from '../conversations/conversations.service';
import {
  CHAT_EVENTS,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageReadEvent,
  type MessageUpdatedEvent,
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
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
  ) {}

  /**
   * Xác thực JWT token từ handshake (Supabase Auth).
   * Chỉ chấp nhận qua handshake.auth.token hoặc Authorization Bearer header.
   * Disconnect ngay lập tức nếu token không hợp lệ hoặc thiếu.
   */
  async handleConnection(client: TypedSocket): Promise<void> {
    try {
      const authHeader = client.handshake.headers?.authorization;
      const rawToken =
        client.handshake.auth?.token ||
        (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined);

      const token = typeof rawToken === 'string' ? rawToken.trim() : null;

      if (!token) {
        this.logger.warn(`Từ chối kết nối socket ${client.id}: thiếu token`);
        client.disconnect(true);
        return;
      }

      const { data: authData, error } =
        await this.supabase.client.auth.getUser(token);

      if (error || !authData?.user) {
        this.logger.warn(
          `Từ chối kết nối socket ${client.id}: token không hợp lệ (${error?.message})`,
        );
        client.disconnect(true);
        return;
      }

      const userId = authData.user.id;
      client.data.userId = userId;

      // Auto-join user room của chính họ (dùng cho direct notification)
      void client.join(Room.user(userId));

      this.logger.log(
        `Socket ${client.id} xác thực thành công cho user ${userId}`,
      );
    } catch (err) {
      this.logger.error(`Lỗi xác thực socket connection ${client.id}:`, err);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: TypedSocket): void {
    const userId = client.data.userId;
    if (userId) {
      this.clearUserTyping(userId);
      this.logger.log(`Socket ${client.id} (user ${userId}) đã ngắt kết nối`);
    }
  }

  @SubscribeMessage('conversation:join')
  async handleConversationJoin(
    client: TypedSocket,
    payload: { conversationId: string },
  ): Promise<{ success: boolean; error?: string }> {
    const userId = client.data.userId;
    if (!userId) {
      return { success: false, error: 'Chưa xác thực' };
    }

    if (!isValidUuid(payload?.conversationId)) {
      return {
        success: false,
        error: 'conversationId không hợp lệ (phải là UUID hợp lệ)',
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
      };
    }

    await client.join(Room.conversation(payload.conversationId));
    return { success: true };
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
  handleMessageCreated(event: MessageCreatedEvent): void {
    const { conversationId, message } = event;
    if (conversationId) {
      const room = Room.conversation(conversationId);
      this.server?.to(room).emit('message:created', { message });
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
