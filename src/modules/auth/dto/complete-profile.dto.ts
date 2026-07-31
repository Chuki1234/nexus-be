import { Transform, TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IsBirthdate } from '../../../common/decorators/is-birthdate.decorator';
import {
  DISPLAY_NAME_MAX_LENGTH,
  MIN_AGE_YEARS,
  USERNAME_PATTERN,
} from '../../../shared/dto/auth';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimLower = (params: TransformFnParams): unknown => {
  const trimmed = trim(params);
  return typeof trimmed === 'string' ? trimmed.toLowerCase() : trimmed;
};

const emptyToUndefined = (params: TransformFnParams): unknown => {
  const trimmed = trim(params);
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Thân request của POST /api/auth/complete-profile.
 *
 * Khác `RegisterDto`: không có email/mật khẩu — người dùng đã đăng nhập bằng
 * Google/SĐT nên `auth.users` đã tồn tại; ở đây chỉ điền nốt hồ sơ `profiles`.
 */
export class CompleteProfileDto {
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

  @IsBirthdate(MIN_AGE_YEARS, {
    message: `Ngày sinh không hợp lệ hoặc bạn chưa đủ ${MIN_AGE_YEARS} tuổi.`,
  })
  dateOfBirth: string;
}
