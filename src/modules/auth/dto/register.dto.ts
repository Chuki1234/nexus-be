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
import {
  DISPLAY_NAME_MAX_LENGTH,
  MIN_AGE_YEARS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
} from '../../../shared/dto/auth';

export { MIN_AGE_YEARS, USERNAME_PATTERN };

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
  @MaxLength(DISPLAY_NAME_MAX_LENGTH, {
    message: `Tên hiển thị tối đa ${DISPLAY_NAME_MAX_LENGTH} ký tự.`,
  })
  displayName?: string;

  @IsString({ message: 'Mật khẩu không hợp lệ.' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`,
  })
  // Supabase băm bằng bcrypt, vốn chỉ tính 72 byte đầu — cắt ở đây cho rõ ràng.
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `Mật khẩu tối đa ${PASSWORD_MAX_LENGTH} ký tự.`,
  })
  password: string;

  @IsBirthdate(MIN_AGE_YEARS, {
    message: `Ngày sinh không hợp lệ hoặc bạn chưa đủ ${MIN_AGE_YEARS} tuổi.`,
  })
  dateOfBirth: string;
}
