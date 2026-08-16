/**
 * Hợp đồng sự kiện Socket.IO giữa Angular và NestJS.
 *
 * `CLAUDE.md`: mọi socket event phải có interface ở đây TRƯỚC khi implement.
 * Các phase P5 / P6 / P11 / C2 / C4 sẽ hiện thực dần, nhưng tên và hình dạng
 * payload chốt từ bây giờ để hai bên không tự đặt tên lệch nhau.
 *
 * Hai thứ cố tình KHÔNG đi qua socket:
 *   - Gửi tin nhắn: dùng `POST /api/channels/:id/messages`. Socket chỉ để nhận.
 *     Gửi qua socket sẽ phải tự dựng lại ack/timeout/retry mà HTTP đã có sẵn.
 *   - Trạng thái bên trong phòng gọi: lấy từ sự kiện của LiveKit. Các event
 *     `voice:*` dưới đây chỉ phục vụ người ĐỨNG NGOÀI phòng.
 *
 * File này được nhân bản y hệt ở `nexus-fe/src/shared/`.
 */

/** `messages.id` là bigint — truyền dạng chuỗi để không mất chính xác trong JS. */
export type MessageId = string;

export interface MessagePayload {
  id: MessageId;
  channelId: string | null;
  conversationId: string | null;
  authorId: string | null;
  type: 'default' | 'system_join' | 'system_leave';
  content: string | null;
  replyToId: MessageId | null;
  clientNonce: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface NotificationPayload {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  /** Vào phòng của một channel để nhận tin realtime. */
  'channel:join': (payload: { channelId: string }) => void;
  'channel:leave': (payload: { channelId: string }) => void;

  'typing:start': (payload: { channelId: string }) => void;
  'typing:stop': (payload: { channelId: string }) => void;
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'message:new': (payload: { message: MessagePayload }) => void;
  'message:updated': (payload: { message: MessagePayload }) => void;
  'message:deleted': (payload: { channelId: string; messageId: MessageId }) => void;

  /** Danh sách người đang gõ trong channel, gửi lại toàn bộ chứ không gửi delta. */
  'typing:update': (payload: { channelId: string; userIds: string[] }) => void;

  'unread:update': (payload: {
    channelId: string;
    unreadCount: number;
    mentionCount: number;
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
  /** Kênh riêng của một user — dùng cho thông báo và chuông cuộc gọi. */
  user: (userId: string) => `user:${userId}`,
} as const;

/** Tên phòng LiveKit. Xem NEXUS_CONTEXT §3.5. */
export const LiveKitRoom = {
  voiceChannel: (channelId: string) => `voice:${channelId}`,
  directCall: (conversationId: string) => `dm:${conversationId}`,
} as const;
