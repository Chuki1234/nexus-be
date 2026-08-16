/**
 * Hợp đồng request/response của các endpoint `/api/auth/*`.
 *
 * Trước đây các kiểu này bị chép tay ở cả hai phía và đã lệch nhau vài lần.
 * Giờ khai báo một chỗ; backend gắn decorator validate lên DTO class riêng, còn
 * hình dạng dữ liệu thì lấy từ đây.
 *
 * File này được nhân bản y hệt ở `nexus-fe/src/shared/`.
 */

/** Ngày dạng `YYYY-MM-DD`. */
export type IsoDate = string;

export interface RegisterRequest {
  email: string;
  username: string;
  displayName?: string;
  password: string;
  dateOfBirth: IsoDate;
}

export interface RegisterResponse {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
}

export interface LoginRequest {
  /** Email hoặc tên đăng nhập — backend tự phân biệt (NEXUS_CONTEXT §3.6). */
  identifier: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  /** Giây Unix. Null nếu Supabase không trả về. */
  expiresAt: number | null;
}

export interface CompleteProfileRequest {
  username: string;
  displayName?: string;
  dateOfBirth: IsoDate;
}

export interface Profile {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  dateOfBirth: IsoDate;
}

/** `profile` là null khi tài khoản chưa hoàn tất hồ sơ (đăng nhập Google lần đầu). */
export interface MeResponse {
  profile: Profile | null;
}

/** Giới hạn dùng chung cho form Angular, DTO NestJS và CHECK trong Postgres. */
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 8;
/** Supabase băm bằng bcrypt, vốn chỉ tính 72 byte đầu. */
export const PASSWORD_MAX_LENGTH = 72;
export const DISPLAY_NAME_MAX_LENGTH = 32;
export const MIN_AGE_YEARS = 13;
