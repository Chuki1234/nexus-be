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

/**
 * Widget trò chơi nào trên hồ sơ. Mỗi loại là một khối riêng, hạn mức riêng.
 *
 * Gộp chung một danh sách rồi lọc theo `kind` chứ không tách bốn cột trong
 * database: cả bốn đều nhỏ, luôn đọc kèm hồ sơ, không bao giờ query riêng —
 * tách ra chỉ tốn thêm bốn ràng buộc phải giữ đồng bộ với nhau.
 */
export type ProfileGameKind = 'rotation' | 'favorite' | 'like' | 'wishlist';

/** Một trò chơi người dùng khoe trên hồ sơ. */
export interface ProfileGame {
  /**
   * Khoá ổn định, duy nhất trong cả danh sách, dạng `kind:slug-tên-game`.
   *
   * Cần khoá riêng chứ không dùng `title`: Angular `@for` ném lỗi runtime khi
   * `track` trùng giá trị, mà cùng một game hoàn toàn có thể nằm ở hai widget
   * khác nhau (vừa đang chơi vừa yêu thích).
   */
  id: string;
  kind: ProfileGameKind;
  title: string;
  /** Ảnh bìa `https://`. `null` = dùng ảnh sinh tự động theo tên. */
  cover: string | null;
  /** Nhãn tự do ("Đang chơi", "142 giờ"). Chỉ widget `rotation` dùng tới. */
  tags: string[];
}

/** Tên hiển thị của từng widget. Dùng chung cho UI lẫn câu báo lỗi. */
export const GAME_KIND_LABELS: Record<ProfileGameKind, string> = {
  rotation: 'Trò Chơi Luân Phiên',
  favorite: 'Trò Chơi Yêu Thích',
  like: 'Trò Chơi Tôi Thích',
  wishlist: 'Muốn Chơi',
};

/**
 * Số trò chơi tối đa của từng widget.
 *
 * `favorite` chỉ 1 vì đúng nghĩa "trò chơi yêu thích nhất" — cho nhiều thì nó
 * thành bản sao của `like`. Phải khớp ràng buộc `profile_games_valid` dưới
 * database, sửa một bên là phải sửa cả hai.
 */
const GAME_LIMITS: Record<ProfileGameKind, number> = {
  rotation: 5,
  favorite: 1,
  like: 20,
  wishlist: 20,
};

export function gameLimitFor(kind: ProfileGameKind): number {
  return GAME_LIMITS[kind];
}

/** Tổng trần cho cả danh sách — chặn ở tầng mảng trước khi xét từng loại. */
export const MAX_PROFILE_GAMES = 46;

export const GAME_TITLE_MAX = 64;
export const GAME_TAG_MAX = 24;
export const MAX_GAME_TAGS = 4;
export const GAME_COVER_URL_MAX = 2048;

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
  birthdate?: IsoDate | null;
  links: ProfileLink[];
  /** Trò chơi khoe trên hồ sơ, gộp cả bốn widget — lọc theo `kind` khi hiển thị. */
  games: ProfileGame[];
  /** Màu nền ảnh bìa người dùng tự chọn. Null = tự động băm từ username. */
  accentColor: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** True khi người xem chính là chủ hồ sơ — frontend dựa vào đây để hiện nút sửa. */
  isSelf: boolean;
  /**
   * Bạn chung giữa người xem và chủ hồ sơ. Luôn rỗng khi `isSelf` — so bạn bè
   * với chính mình không có ý nghĩa gì, backend bỏ qua việc tính cho nhanh.
   */
  mutualFriends: ProfileSummary[];
  /** Máy chủ mà cả người xem lẫn chủ hồ sơ đều là thành viên. Cũng rỗng khi `isSelf`. */
  mutualServers: MutualServer[];
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

/** Một máy chủ trong danh sách "máy chủ chung" trên hồ sơ người khác. */
export interface MutualServer {
  id: string;
  name: string;
  iconUrl: string | null;
}

/** Ghi chú riêng tư người xem tự viết về chủ hồ sơ — chỉ người viết thấy được. */
export const PROFILE_NOTE_MAX = 256;

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
  /** Cũng thay CẢ danh sách như `links`. Mảng rỗng = gỡ hết trò chơi. */
  games?: ProfileGame[];
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
