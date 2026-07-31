/**
 * Bitfield quyền kiểu Discord — nguồn chân lý cho cả frontend lẫn backend.
 *
 * ⚠️ PHẢI dùng `bigint`, không dùng `number`.
 *
 * Toán tử bitwise của JavaScript ép toán hạng về số nguyên 32 bit có dấu. Với
 * `number` thì `1 << 62` cho ra `1073741824` (đúng bằng `1 << 30`) — tức là
 * ADMINISTRATOR sẽ trùng bit với một quyền khác và ai cũng thành quản trị viên.
 * Chỉ `1n << 62n` mới ra đúng giá trị.
 *
 * ⚠️ Đọc cột `permissions` từ Supabase phải ép sang text.
 *
 * PostgREST trả `bigint` dưới dạng số JSON. `2^62` vượt `Number.MAX_SAFE_INTEGER`
 * nên sẽ mất chính xác ngay khi parse. Query phải viết:
 *     .select('id, name, permissions::text')
 * rồi `BigInt(row.permissions)`.
 *
 * File này được nhân bản y hệt ở `nexus-fe/src/shared/`. Sửa một bên phải sửa cả
 * hai — chạy `npm run check:shared` để phát hiện lệch.
 */

export const Permission = {
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  /** Xoá / sửa tin nhắn của người khác. */
  MANAGE_MESSAGES: 1n << 2n,
  ATTACH_FILES: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 5n,
  KICK_MEMBERS: 1n << 6n,
  BAN_MEMBERS: 1n << 7n,
  CREATE_INVITE: 1n << 8n,
  MANAGE_SERVER: 1n << 9n,
  CONNECT_VOICE: 1n << 10n,
  SPEAK_VOICE: 1n << 11n,
  /** Bỏ qua mọi kiểm tra quyền, kể cả overwrite deny. */
  ADMINISTRATOR: 1n << 62n,
} as const;

export type PermissionName = keyof typeof Permission;

/** Hợp của mọi quyền đã định nghĩa — giá trị trả về khi có ADMINISTRATOR. */
export const ALL_PERMISSIONS: bigint = Object.values(Permission).reduce(
  (all, bit) => all | bit,
  0n,
);

/**
 * Quyền mặc định của role `@everyone` khi tạo server mới.
 *
 * Phải khớp con số hardcode `3339` trong hàm SQL `create_default_role()`
 * (migration 20260731090200). Có unit test canh chừng cặp giá trị này.
 */
export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.CREATE_INVITE |
  Permission.CONNECT_VOICE |
  Permission.SPEAK_VOICE;

/** Một dòng trong `channel_overwrites`. */
export interface PermissionOverwrite {
  allow: bigint;
  deny: bigint;
}

export interface EffectivePermissionInput {
  /** Quyền của mọi role user đang giữ trong server, gồm cả `@everyone`. */
  rolePermissions: readonly bigint[];
  /** Overwrite của role `@everyone` trên channel đang xét. */
  everyoneOverwrite?: PermissionOverwrite | null;
  /** Overwrite của các role khác, theo thứ tự `position` tăng dần. */
  roleOverwrites?: readonly PermissionOverwrite[];
  /** Overwrite gắn thẳng vào một thành viên cụ thể. */
  memberOverwrite?: PermissionOverwrite | null;
}

/**
 * Tính quyền hiệu lực của một user trên một channel.
 *
 * Thứ tự áp overwrite là `@everyone` → các role → member, và **không được đổi**:
 * member phải áp sau cùng để một overwrite cấp cá nhân có thể gỡ lệnh cấm của
 * role. Áp sai thứ tự thì user tự nâng quyền được.
 *
 * Trong mỗi bước, deny áp trước allow — allow thắng khi cùng một bit bị đặt ở cả
 * hai bên.
 */
export function computeEffectivePermissions(input: EffectivePermissionInput): bigint {
  const base = input.rolePermissions.reduce((perms, role) => perms | role, 0n);

  // ADMINISTRATOR bỏ qua toàn bộ overwrite, kể cả deny tường minh.
  if ((base & Permission.ADMINISTRATOR) !== 0n) {
    return ALL_PERMISSIONS;
  }

  const steps: (PermissionOverwrite | null | undefined)[] = [
    input.everyoneOverwrite,
    ...(input.roleOverwrites ?? []),
    input.memberOverwrite,
  ];

  return steps.reduce<bigint>((perms, overwrite) => {
    if (!overwrite) {
      return perms;
    }
    return (perms & ~overwrite.deny) | overwrite.allow;
  }, base);
}

/** Kiểm tra một tập quyền có chứa (các) quyền cần thiết hay không. */
export function hasPermission(perms: bigint, required: bigint): boolean {
  return (perms & required) === required;
}
