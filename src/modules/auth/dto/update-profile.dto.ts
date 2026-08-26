import { IsOptional, IsString, MaxLength } from 'class-validator';
import { DISPLAY_NAME_MAX_LENGTH } from '../../../shared/dto/auth';
import type { UpdateProfileRequest } from '../../../shared/dto/profile';

export class UpdateProfileDto implements UpdateProfileRequest {
  @IsOptional()
  @IsString({ message: 'Tên hiển thị phải là chuỗi.' })
  @MaxLength(DISPLAY_NAME_MAX_LENGTH, {
    message: `Tên hiển thị tối đa ${DISPLAY_NAME_MAX_LENGTH} ký tự.`,
  })
  displayName?: string | null;

  @IsOptional()
  @IsString({ message: 'Avatar URL phải là chuỗi.' })
  avatarUrl?: string | null;

  @IsOptional()
  @IsString({ message: 'Màu banner phải là chuỗi.' })
  bannerColor?: string | null;

  @IsOptional()
  @IsString({ message: 'Trạng thái tùy chỉnh phải là chuỗi.' })
  @MaxLength(128, { message: 'Trạng thái tùy chỉnh tối đa 128 ký tự.' })
  customStatus?: string | null;
}
