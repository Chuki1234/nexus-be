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

/** Khi 2FA không bật: trả session ngay. */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  /** Giây Unix. Null nếu Supabase không trả về. */
  expiresAt: number | null;
  requiresMfa?: false;
}

/**
 * Khi 2FA bật: trả challenge để frontend điều hướng sang màn nhập TOTP.
 * `accessToken` ở đây là AAL1 (chỉ xác thực mật khẩu) — không đủ để gọi API;
 * cần gửi lên /auth/2fa/verify-login để nâng lên AAL2 và nhận session thật.
 */
export interface LoginMfaRequired {
  requiresMfa: true;
  mfaChallengeId: string;
  /** Access token tạm AAL1, chỉ dùng cho /auth/2fa/verify-login. */
  accessToken: string;
}

/** Union trả về từ POST /api/auth/login. */
export type LoginResult = LoginResponse | LoginMfaRequired;

// ── 2FA / TOTP ────────────────────────────────────────────────────────────────

export interface TotpEnrollResponse {
  /** URI dạng otpauth:// để tạo QR code ở frontend. */
  qrCodeUrl: string;
  /** Secret text (Base32) để nhập tay vào app nếu không quét được QR. */
  secret: string;
  factorId: string;
}

export interface TotpStatusResponse {
  enabled: boolean;
  factorId: string | null;
}

/**
 * Backup codes trả về một lần duy nhất sau khi bật 2FA (hoặc khi tạo lại).
 * Frontend phải nhắc người dùng lưu lại, vì sau đó không xem lại được.
 */
export interface BackupCodesResponse {
  codes: string[];
}

export interface VerifyMfaRequest {
  challengeId: string;
  code: string;
  /** Access token tạm AAL1 nhận được từ /login khi requiresMfa = true. */
  accessToken: string;
}

export interface FastLoginTotpRequest {
  /** Email hoặc tên đăng nhập */
  identifier: string;
  /** Mã 6 chữ số từ Google Authenticator hoặc mã dự phòng 8 ký tự */
  code: string;
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
  avatarUrl?: string | null;
  bannerColor?: string | null;
  customStatus?: string | null;
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
/** Mật khẩu phải chứa ít nhất một chữ cái và một số */
export const PASSWORD_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d)/;
export const DISPLAY_NAME_MAX_LENGTH = 32;
export const MIN_AGE_YEARS = 13;
