import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const MAX_PROFILE_LINKS = 5;
export const DISPLAY_NAME_MAX = 32;
export const STATUS_MESSAGE_MAX = 120;
export const BIO_MAX = 300;
export const LOCATION_MAX = 64;
export const LINK_LABEL_MAX = 32;
export const LINK_URL_MAX = 2048;

/**
 * Bảng màu accent color — PHẢI khớp constraint `profiles_accent_color_valid`
 * (migration `profile_accent_color`) và `BANNER_FALLBACKS` bên frontend
 * (`banner-color.ts`). Đổi một trong ba nơi này thì phải đổi cả ba.
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

/**
 * Ô để trống nghĩa là "xoá thông tin này", nên chuỗi rỗng thành `null` chứ không
 * thành `undefined`: `undefined` bị hiểu là "không đụng tới trường này".
 */
const emptyToNull = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Chỉ hạ chữ thường phần scheme, giữ nguyên phần còn lại (đường dẫn và query của
 * nhiều trang phân biệt hoa thường). Ràng buộc `profiles_links_shape` dưới DB so
 * khớp chính xác chuỗi 'https://' nên bước này là bắt buộc, không chỉ là làm đẹp.
 */
const normalizeUrl = (params: TransformFnParams): unknown => {
  const trimmed = trim(params);
  return typeof trimmed === 'string'
    ? trimmed.replace(/^https:\/\//i, 'https://')
    : trimmed;
};

/** Một link ra ngoài trên trang hồ sơ: GitHub, YouTube, portfolio… */
export class ProfileLinkDto {
  @Transform(trim)
  @IsString({ message: 'Nhãn link không hợp lệ.' })
  @MinLength(1, { message: 'Nhãn link không được để trống.' })
  @MaxLength(LINK_LABEL_MAX, {
    message: `Nhãn link tối đa ${LINK_LABEL_MAX} ký tự.`,
  })
  label: string;

  /**
   * Chỉ nhận https. Chặn `javascript:` (chạy script khi người xem bấm vào) và
   * `http://` (trình duyệt chặn/cảnh báo khi trang chạy trên https).
   */
  @Transform(normalizeUrl)
  @IsString({ message: 'Địa chỉ link không hợp lệ.' })
  @MaxLength(LINK_URL_MAX, { message: 'Địa chỉ link quá dài.' })
  @Matches(/^https:\/\/[^\s]+$/, {
    message: 'Link phải bắt đầu bằng https:// và không chứa khoảng trắng.',
  })
  url: string;
}

/**
 * Thân request của PATCH /api/profiles/me.
 *
 * Ngữ nghĩa PATCH: trường không gửi lên thì giữ nguyên, gửi `null` (hoặc chuỗi
 * rỗng) thì xoá. `username` và `birthdate` cố tình không có ở đây — username là
 * định danh công khai, birthdate dùng để kiểm tra tuổi; đổi hai thứ đó cần luồng
 * riêng chứ không nằm trong "sửa hồ sơ".
 */
export class UpdateProfileDto {
  @Transform(emptyToNull)
  @IsOptional()
  @IsString({ message: 'Tên hiển thị không hợp lệ.' })
  @MaxLength(DISPLAY_NAME_MAX, {
    message: `Tên hiển thị tối đa ${DISPLAY_NAME_MAX} ký tự.`,
  })
  displayName?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString({ message: 'Dòng trạng thái không hợp lệ.' })
  @MaxLength(STATUS_MESSAGE_MAX, {
    message: `Dòng trạng thái tối đa ${STATUS_MESSAGE_MAX} ký tự.`,
  })
  statusMessage?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString({ message: 'Giới thiệu không hợp lệ.' })
  @MaxLength(BIO_MAX, { message: `Giới thiệu tối đa ${BIO_MAX} ký tự.` })
  bio?: string | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString({ message: 'Nơi ở không hợp lệ.' })
  @MaxLength(LOCATION_MAX, { message: `Nơi ở tối đa ${LOCATION_MAX} ký tự.` })
  location?: string | null;

  /**
   * `null` = tự động (băm từ username, hành vi cũ). Chỉ nhận đúng 8 giá trị
   * trong bảng — không phải color-picker tự do, để không phải kiểm tương phản
   * cho một màu bất kỳ trên cả 5 theme giao diện.
   */
  @Transform(emptyToNull)
  @IsOptional()
  @IsIn([...ACCENT_COLORS, null], { message: 'Màu không hợp lệ.' })
  accentColor?: string | null;

  /**
   * Gửi lên là thay toàn bộ danh sách (không phải thêm vào). Mảng rỗng = xoá hết.
   * `@Type` bắt buộc: thiếu nó thì class-transformer để nguyên object thường và
   * `@ValidateNested` không có gì để kiểm.
   */
  @IsOptional()
  @IsArray({ message: 'Danh sách link không hợp lệ.' })
  @ArrayMaxSize(MAX_PROFILE_LINKS, {
    message: `Tối đa ${MAX_PROFILE_LINKS} link.`,
  })
  @ValidateNested({ each: true })
  @Type(() => ProfileLinkDto)
  links?: ProfileLinkDto[];
}
