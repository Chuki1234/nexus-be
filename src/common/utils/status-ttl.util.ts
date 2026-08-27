/**
 * Trạng thái tuỳ chỉnh ("custom status") tự hết hạn sau ĐÚNG 24h kể từ lúc lưu.
 *
 * Thời hạn CỐ ĐỊNH — người dùng không cấu hình được. Mỗi lần lưu nội dung mới sẽ
 * reset lại đồng hồ 24h. Hết hạn thì nội dung tự biến mất ở mọi nơi.
 *
 * Cơ chế hai lớp, bổ trợ nhau:
 *  - Cột `status_message_expires_at` lưu mốc hết hạn; job pg_cron dọn định kỳ để
 *    các surface khác (danh sách chat, bạn bè) tự sạch mà không phải sửa.
 *  - `activeStatus()` lọc lúc ĐỌC hồ sơ để ẩn tức thì, không phải chờ cron.
 */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

/** Mốc hết hạn (ISO) cho status vừa lưu; `null` khi xoá trắng (không hết hạn gì để đặt). */
export function statusExpiryFor(message: string | null | undefined): string | null {
  const hasStatus = typeof message === 'string' && message.trim().length > 0;
  return hasStatus ? new Date(Date.now() + STATUS_TTL_MS).toISOString() : null;
}

/** Trạng thái còn hiệu lực để trả ra client: `null` nếu rỗng hoặc đã quá 24h. */
export function activeStatus(
  message: string | null,
  expiresAt: string | null,
): string | null {
  if (!message) return null;
  if (!expiresAt) return null;
  return new Date(expiresAt).getTime() > Date.now() ? message : null;
}
