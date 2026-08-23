/**
 * Hợp đồng sự kiện Socket.IO giữa Angular và NestJS.
 *
 * `CLAUDE.md`: mọi socket event phải có interface ở đây TRƯỚC khi implement.
 * Các phase P5 / P6 / P11 / C2 / C4 / DM-2 hiện thực dần, nhưng tên và hình dạng
 * payload chốt từ bây giờ để hai bên không tự đặt tên lệch nhau.
 *
 * Hai thứ cố tình KHÔNG đi qua socket:
 *   - Gửi tin nhắn: dùng `POST /api/channels/:id/messages` hoặc `POST /api/conversations/:id/messages`.
 *     Socket chỉ để nhận. Gửi qua HTTP có ack/timeout/retry/idempotency chuẩn.
 *   - Trạng thái bên trong phòng gọi: lấy từ sự kiện của LiveKit. Các event
 *     `voice:*` dưới đây chỉ phục vụ người ĐỨNG NGOÀI phòng.
 *
 * File này được nhân bản y hệt ở `nexus-fe/src/shared/`.
 */

/** `messages.id` là bigint — truyền dạng chuỗi để không mất chính xác trong JS. */
export type MessageId = string;

export interface MessageAuthorPayload {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AttachmentPayload {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  signedUrl: string | null;
  isAvailable?: boolean;
}

export interface ReactionSummaryPayload {
  emoji: string;
  count: number;
  reactedByMe?: boolean;
}

export interface MessagePayload {
  id: MessageId;
  channelId: string | null;
  conversationId: string | null;
  authorId: string | null;
  author?: MessageAuthorPayload;
  type: 'default' | 'system_join' | 'system_leave';
  content: string | null;
  replyToId: MessageId | null;
  clientNonce: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  isForwarded: boolean;
  attachments?: AttachmentPayload[];
  reactions?: ReactionSummaryPayload[];
  createdAt: string;
}

export interface ReactionUpdatedPayload {
  messageId: MessageId;
  conversationId: string;
  actorUserId: string;
  emoji: string;
  action: 'added' | 'removed';
  clientMutationId?: string;
  reactions: Array<{
    emoji: string;
    count: number;
  }>;
}

export interface NotificationPayload {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

import type { PresenceStatus } from './dto/common';
export type { PresenceStatus };

export interface PresenceUpdatedPayload {
  userId: string;
  status: PresenceStatus;
  lastSeenAt: string | null;
}

export interface PresenceSyncPayload {
  presences: Record<string, { status: PresenceStatus; lastSeenAt: string | null }>;
}

export interface JoinConversationResponse {
  success: boolean;
  error?: string;
  status?: 'joined' | 'queued' | 'disconnected' | 'rejected' | 'timeout';
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  /** Vào phòng của một conversation để nhận tin realtime. */
  'conversation:join': (
    payload: { conversationId: string },
    callback?: (response: JoinConversationResponse) => void,
  ) => void;
  'conversation:leave': (payload: { conversationId: string }) => void;

  'typing:start': (payload: { conversationId: string }) => void;
  'typing:stop': (payload: { conversationId: string }) => void;

  /** Yêu cầu lấy snapshot trạng thái của bạn bè và DM peers */
  'presence:get-snapshot': (
    callback?: (response: PresenceSyncPayload) => void,
  ) => void;
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  /** Cập nhật trạng thái hiện diện realtime */
  'presence:updated': (payload: PresenceUpdatedPayload) => void;
  /** Đồng bộ toàn bộ snapshot hiện diện ban đầu */
  'presence:sync': (payload: PresenceSyncPayload) => void;

  /** Chuẩn hóa tên event tin nhắn duy nhất */
  'message:created': (payload: { message: MessagePayload }) => void;
  'message:updated': (payload: { message: MessagePayload }) => void;
  'message:deleted': (payload: {
    channelId: string | null;
    conversationId: string | null;
    messageId: MessageId;
  }) => void;
  'message:reaction-updated': (payload: ReactionUpdatedPayload) => void;

  'message:read': (payload: {
    conversationId: string;
    userId: string;
    lastReadMessageId: MessageId;
  }) => void;

  /** Danh sách người đang gõ trong room, gửi lại toàn bộ chứ không gửi delta. */
  'typing:updated': (payload: {
    conversationId: string;
    userIds: string[];
  }) => void;

  'unread:update': (payload: {
    channelId?: string;
    conversationId?: string;
    unreadCount: number;
    mentionCount: number;
  }) => void;

  /** Thông báo cấp user-room khi có tin nhắn mới trong conversation mà user chưa join room. */
  'conversation:updated': (payload: {
    conversationId: string;
    senderId: string;
    lastMessageId: MessageId;
    lastMessagePreview: string | null;
    lastMessageAt: string;
    unreadDelta: number;
  }) => void;

  'notification:new': (payload: { notification: NotificationPayload }) => void;

  /**
   * Ai đang trong voice channel — dành cho người CHƯA vào phòng.
   * Người đã ở trong phòng lấy danh sách từ LiveKit, không dùng event này.
   */
  'voice:participants': (payload: { channelId: string; userIds: string[] }) => void;

  'call:incoming': (payload: { conversationId: string; fromUserId: string }) => void;
  'call:answered': (payload: { conversationId: string }) => void;
  'call:declined': (payload: { conversationId: string }) => void;
  'call:ended': (payload: { conversationId: string }) => void;
}

/** Tên room trên server. Đặt tập trung để hai bên không tự ghép chuỗi lệch nhau. */
export const Room = {
  channel: (channelId: string) => `channel:${channelId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  /** Kênh riêng của một user — dùng cho thông báo và chuông cuộc gọi. */
  user: (userId: string) => `user:${userId}`,
} as const;

/** Tên phòng LiveKit. Xem NEXUS_CONTEXT §3.5. */
export const LiveKitRoom = {
  voiceChannel: (channelId: string) => `voice:${channelId}`,
  directCall: (conversationId: string) => `dm:${conversationId}`,
} as const;
