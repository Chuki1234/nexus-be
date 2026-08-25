/**
 * Hợp đồng sự kiện Socket.IO giữa Angular và NestJS.
 *
 * `CLAUDE.md`: mọi socket event phải có interface ở đây TRƯỚC khi implement.
 * Các phase P5 / P6 / P11 / C2 / C4 / DM-2 / C12 hiện thực dần, nhưng tên và hình dạng
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

import type { DirectCallDto } from './dto/direct-calls.dto';

/** `messages.id` là bigint — truyền dạng chuỗi để không mất chính xác trong JS. */
export type MessageId = string;

export type ChatTargetPayload =
  | { conversationId: string; channelId?: never }
  | { channelId: string; conversationId?: never };

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

import type { GiphyMediaDto } from './dto/messages.dto';

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
  externalMedia: GiphyMediaDto | null;
  attachments?: AttachmentPayload[];
  reactions?: ReactionSummaryPayload[];
  createdAt: string;
}

export interface ReactionUpdatedPayload {
  messageId: MessageId;
  conversationId?: string | null;
  channelId?: string | null;
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

  /** Vào phòng của một server channel để nhận tin realtime. */
  'channel:join': (
    payload: { channelId: string },
    callback?: (response: JoinConversationResponse) => void,
  ) => void;
  'channel:leave': (
    payload: { channelId: string },
    callback?: (res: { success: boolean }) => void,
  ) => void;

  'typing:start': (payload: { conversationId?: string; channelId?: string }) => void;
  'typing:stop': (payload: { conversationId?: string; channelId?: string }) => void;

  /** Yêu cầu lấy snapshot trạng thái của bạn bè và DM peers */
  'presence:get-snapshot': (
    callback?: (response: PresenceSyncPayload) => void,
  ) => void;

  /** Client yêu cầu tham gia server room (xác thực membership phía backend). */
  'server:join': (
    payload: { serverId: string },
    callback: (res: { success: boolean; error?: string }) => void,
  ) => void;

  /** Client rời khỏi server room. */
  'server:leave': (
    payload: { serverId: string },
    callback?: (res: { success: boolean }) => void,
  ) => void;
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'message:created': (payload: { message: MessagePayload }) => void;
  'message:updated': (payload: { message: MessagePayload }) => void;
  'message:deleted': (payload: { messageId: MessageId; channelId?: string | null; conversationId?: string | null }) => void;
  'message:reaction-updated': (payload: ReactionUpdatedPayload) => void;

  'message:read': (payload: {
    conversationId?: string | null;
    channelId?: string | null;
    readerId?: string;
    userId?: string;
    lastReadMessageId: MessageId;
  }) => void;

  'presence:updated': (payload: PresenceUpdatedPayload) => void;
  'presence:sync': (payload: PresenceSyncPayload) => void;

  'typing:updated': (payload: {
    channelId?: string | null;
    conversationId?: string | null;
    userIds: string[];
  }) => void;

  'unread:update': (payload: {
    channelId?: string | null;
    conversationId?: string | null;
    serverId?: string;
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

  /** Sự kiện tạo kênh mới trong server */
  'server:channel-created': (payload: {
    serverId: string;
    channel: {
      id: string;
      name: string;
      type: 'text' | 'voice';
      topic: string | null;
      position: number;
      unread: boolean;
      mentionCount: number;
    };
  }) => void;

  /** Sự kiện cập nhật thông tin kênh trong server */
  'server:channel-updated': (payload: {
    serverId: string;
    channel: {
      id: string;
      name: string;
      type: 'text' | 'voice';
      topic: string | null;
      position?: number;
      unread?: boolean;
      mentionCount?: number;
    };
  }) => void;

  /** Sự kiện xóa kênh trong server */
  'server:channel-deleted': (payload: {
    serverId: string;
    channelId: string;
  }) => void;

  /** Sự kiện danh sách kênh trong server bị thay đổi (tạo/sửa/xóa/đổi quyền) */
  'server:channels-invalidated': (payload: { serverId: string }) => void;

  /** Sự kiện thành viên mới tham gia server */
  'server:member-joined': (payload: {
    serverId: string;
    userId: string;
    role?: string;
  }) => void;

  /** Nhận lời mời tham gia server trực tiếp (gửi vào user room) */
  'server:invitation-received': (payload: {
    invitation: {
      id: string;
      serverId: string;
      serverName: string;
      serverIconUrl: string | null;
      inviterId: string;
      inviterDisplayName: string;
      inviterUsername: string;
      inviterAvatarUrl: string | null;
      status: string;
      createdAt: string;
      expiresAt: string;
    };
  }) => void;

  /** Cập nhật trạng thái lời mời tham gia server (accepted, declined, revoked, expired) */
  'server:invitation-updated': (payload: {
    invitationId: string;
    serverId: string;
    inviteeId: string;
    status: 'accepted' | 'declined' | 'revoked' | 'expired';
  }) => void;

  /** Cập nhật quyền capabilities của user trong server */
  'server:capabilities-updated': (payload: {
    serverId: string;
    capabilities: {
      isOwner: boolean;
      canInviteMembers: boolean;
      canManageServer: boolean;
      canManageChannels: boolean;
      canManageRoles: boolean;
    };
  }) => void;

  /** Sự kiện xóa máy chủ hoàn toàn (gửi vào server room và user rooms của từng thành viên) */
  'server:deleted': (payload: {
    serverId: string;
  }) => void;

  /** Sự kiện thành viên rời khỏi máy chủ */
  'server:member-left': (payload: {
    serverId: string;
    userId: string;
  }) => void;

  /**
   * Ai đang trong voice channel — dành cho người CHƯA vào phòng.
   * Người đã ở trong phòng lấy danh sách từ LiveKit, không dùng event này.
   */
  'voice:participants': (payload: { channelId: string; userIds: string[] }) => void;

  // Direct Call Signaling (DM 1-1 giữa bạn bè)
  'direct-call:incoming': (payload: DirectCallDto) => void;
  'direct-call:ringing': (payload: DirectCallDto) => void;
  'direct-call:accepted': (payload: DirectCallDto) => void;
  'direct-call:connected': (payload: { callId: string; connectedAt: string }) => void;
  'direct-call:declined': (payload: DirectCallDto) => void;
  'direct-call:cancelled': (payload: DirectCallDto) => void;
  'direct-call:ended': (payload: DirectCallDto) => void;
  'direct-call:missed': (payload: DirectCallDto) => void;
  'direct-call:busy': (payload: { conversationId: string; calleeId: string }) => void;
  'direct-call:state-sync': (payload: DirectCallDto | null) => void;
}

/** Tên room trên server. Đặt tập trung để hai bên không tự ghép chuỗi lệch nhau. */
export const Room = {
  channel: (channelId: string) => `channel:${channelId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  server: (serverId: string) => `server:${serverId}`,
  /** Kênh riêng của một user — dùng cho thông báo và chuông cuộc gọi. */
  user: (userId: string) => `user:${userId}`,
} as const;

/** Tên phòng LiveKit. Xem NEXUS_CONTEXT §3.5. */
export const LiveKitRoom = {
  voiceChannel: (channelId: string) => `voice:${channelId}`,
  directCall: (callId: string) => `nexus:dm-call:${callId}`,
} as const;
