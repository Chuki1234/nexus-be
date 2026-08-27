/**
 * Các kiểu liệt kê của cơ sở dữ liệu.
 *
 * Ánh xạ 1-1 với `create type ... as enum` trong `docs/nexus_schema.sql`. Khai báo
 * ở đây để frontend và backend không tự viết lại chuỗi rồi lệch nhau — thêm giá
 * trị mới ở DB thì sửa đúng một chỗ này.
 *
 * File này được nhân bản y hệt ở `nexus-fe/src/shared/`.
 */

/** `automatic_presence_status` — trạng thái hiện diện tự động dựa trên socket & activity */
export type AutomaticPresenceStatus = 'online' | 'idle' | 'offline';

/** `presence_status` — trạng thái hiện diện tổng hợp bao gồm cả lựa chọn thủ công. */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** Alias tương thích */
export type UserPresenceStatus = PresenceStatus;

/** Hằng số thời gian quản lý presence (ms) */
export const PRESENCE_IDLE_AFTER_MS = 15 * 60 * 1000; // 15 phút không hoạt động -> chuyển idle
export const PRESENCE_ACTIVITY_THROTTLE_MS = 30 * 1000; // 30 giây throttle activity từ client

/** DTO dữ liệu trạng thái hiện diện người dùng chuyển giao qua realtime */
export interface UserPresenceDto {
  userId: string;
  status: PresenceStatus;
  lastSeenAt: string | null;
}

/** `channel_type` — 'forum' thêm ngày 31/07 cho màn hình bài đăng. */
export type ChannelType = 'text' | 'voice' | 'forum';

/** `conversation_type` — 'dm' là 1-1, 'group' là nhóm ngoài server. */
export type ConversationType = 'dm' | 'group';

/** `friendship_status` */
export type FriendshipStatus = 'pending' | 'accepted' | 'blocked';

/** `message_type` — hai giá trị sau là tin hệ thống, không phải người dùng gõ. */
export type MessageType = 'default' | 'system_join' | 'system_leave';

/** `overwrite_target` — đích của permission overwrite ở cấp channel. */
export type OverwriteTarget = 'role' | 'member';

/** Nhãn tiếng Việt của từng trạng thái, dùng cho screen reader và tooltip. */
export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: 'Trực tuyến',
  idle: 'Đang vắng',
  dnd: 'Không làm phiền',
  offline: 'Ngoại tuyến',
};
