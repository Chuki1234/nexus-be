/**
 * Các kiểu liệt kê của cơ sở dữ liệu.
 *
 * Ánh xạ 1-1 với `create type ... as enum` trong `docs/nexus_schema.sql`. Khai báo
 * ở đây để frontend và backend không tự viết lại chuỗi rồi lệch nhau — thêm giá
 * trị mới ở DB thì sửa đúng một chỗ này.
 *
 * File này được nhân bản y hệt ở `nexus-fe/src/shared/`.
 */

/** `presence_status` — lựa chọn thủ công của user, không phải trạng thái live. */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

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
  idle: 'Chờ',
  dnd: 'Không làm phiền',
  offline: 'Ngoại tuyến',
};
