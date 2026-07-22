import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsBirthdate } from '../../../common/decorators/is-birthdate.decorator';

/** Giữ khớp với `profiles_username_format` trong supabase/profiles.sql. */
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,32}$/;
export const MIN_AGE_YEARS = 13;

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimLower = (params: TransformFnParams): unknown => {
  const trimmed = trim(params);
  return typeof trimmed === 'string' ? trimmed.toLowerCase() : trimmed;
};

/** Ô "Tên hiển thị" bỏ trống gửi lên là chuỗi rỗng — coi như không khai báo. */
const emptyToUndefined = (params: TransformFnParams): unknown => {
  const trimmed = trim(params);
  return trimmed === '' ? undefined : trimmed;
};

export class RegisterDto {
  @Transform(trimLower)
  @IsEmail({}, { message: 'Email không đúng định dạng.' })
  @MaxLength(254, { message: 'Email quá dài.' })
  email: string;

  @Transform(trimLower)
  @Matches(USERNAME_PATTERN, {
    message:
      'Tên đăng nhập gồm 3–32 ký tự, chỉ chữ thường, số, dấu chấm hoặc gạch dưới.',
  })
  username: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString({ message: 'Tên hiển thị không hợp lệ.' })
  @MaxLength(32, { message: 'Tên hiển thị tối đa 32 ký tự.' })
  displayName?: string;

  @IsString({ message: 'Mật khẩu không hợp lệ.' })
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự.' })
  // Supabase băm bằng bcrypt, vốn chỉ tính 72 byte đầu — cắt ở đây cho rõ ràng.
  @MaxLength(72, { message: 'Mật khẩu tối đa 72 ký tự.' })
  password: string;

  @IsBirthdate(MIN_AGE_YEARS, {
    message: `Ngày sinh không hợp lệ hoặc bạn chưa đủ ${MIN_AGE_YEARS} tuổi.`,
  })
  birthdate: string;
}
