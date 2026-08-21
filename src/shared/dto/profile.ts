/**
 * Hợp đồng request/response của các endpoint `/api/profiles/*`.
 *
 * Khác `dto/auth.ts`: `Profile` bên đó là hồ sơ tối thiểu mà `/auth/me` trả về
 * để biết tài khoản đã hoàn tất đăng ký hay chưa. Ở đây là hồ sơ ĐẦY ĐỦ dùng
 * cho trang cá nhân — ảnh, giới thiệu, liên kết, màu chủ đạo. Hai kiểu cố ý
 * khác tên để không ai vô tình dùng nhầm cái này cho chỗ kia.
 *
 * File này được nhân bản y hệt ở `nexus-be/src/shared/`.
 */

import type { IsoDate } from './auth';

/** Một liên kết ra ngoài trên trang hồ sơ: GitHub, YouTube, portfolio… */
export interface ProfileLink {
  label: string;
  url: string;
}

/** Hồ sơ mà bất kỳ ai đã đăng nhập cũng xem được. */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  statusMessage: string | null;
  bio: string | null;
  location: string | null;
  links: ProfileLink[];
  /** Màu nền ảnh bìa người dùng tự chọn. Null = tự động băm từ username. */
  accentColor: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** True khi người xem chính là chủ hồ sơ — frontend dựa vào đây để hiện nút sửa. */
  isSelf: boolean;
}

/** Hồ sơ của chính mình: `GET /api/profiles/me` trả thêm trường không công khai. */
export interface OwnProfile extends PublicProfile {
  birthdate: IsoDate;
}

/** Một dòng trong kết quả tìm kiếm người dùng. */
export interface ProfileSummary {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Thân request của `PATCH /api/profiles/me`.
 *
 * Ngữ nghĩa PATCH: bỏ trường đi = giữ nguyên, gửi `null` = xoá.
 */
export interface UpdateProfileRequest {
  displayName?: string | null;
  statusMessage?: string | null;
  bio?: string | null;
  location?: string | null;
  accentColor?: string | null;
  /** Gửi lên là thay cả danh sách, không phải thêm vào. */
  links?: ProfileLink[];
}

/** Giới hạn độ dài — khớp DTO backend và ràng buộc CHECK dưới database. */
export const DISPLAY_NAME_MAX = 32;
export const STATUS_MESSAGE_MAX = 120;
export const BIO_MAX = 300;
export const LOCATION_MAX = 64;
export const LINK_LABEL_MAX = 32;
export const LINK_URL_MAX = 2048;
export const MAX_PROFILE_LINKS = 5;

/**
 * Bảng màu chủ đạo cho ảnh bìa.
 *
 * Cố định thành danh sách chứ không cho chọn màu tự do: đây là màu nền trang
 * trí, cho tự do thì sẽ có người chọn màu khiến chữ đè lên không đọc nổi.
 * Phải khớp ràng buộc `profiles_accent_color_valid` dưới database.
 */
export const ACCENT_COLORS = [
  '#4453c4',
  '#2f7a68',
  '#7c46b8',
  '#a8514c',
  '#a8752a',
  '#37628f',
  '#8d3f6b',
  '#3f7a3a',
] as const;

/** Tên để hiển thị: ưu tiên tên tự đặt, không có thì dùng username. */
export function profileDisplayName(profile: {
  displayName: string | null;
  username: string;
}): string {
  return profile.displayName?.trim() || profile.username;
}

/**
 * Màu nền ảnh bìa của một người.
 *
 * Dùng `accentColor` nếu họ đã chọn; chưa chọn thì băm username ra một màu cố
 * định trong bảng. Băm phải ổn định giữa các lần mở và giữa các máy — nếu không
 * thì cùng một người mỗi lần xem lại ra một màu, trông như lỗi hiển thị.
 */
export function bannerColorFor(username: string, accentColor: string | null): string {
  if (accentColor) {
    return accentColor;
  }
  let hash = 0;
  for (const char of username) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 100_000;
  }
  return ACCENT_COLORS[hash % ACCENT_COLORS.length];
}
