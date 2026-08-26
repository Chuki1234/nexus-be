import { IsBirthdate } from '../../../common/decorators/is-birthdate.decorator';
import { MIN_AGE_YEARS } from '../../auth/dto/register.dto';

/**
 * Thân request của PUT /api/profiles/me/birthdate — đi đường riêng, tách khỏi
 * `UpdateProfileDto`, vì đây là dữ liệu dùng để kiểm tra tuổi chứ không phải
 * thông tin trang trí hồ sơ. Dùng lại đúng `IsBirthdate` + `MIN_AGE_YEARS` mà
 * luồng đăng ký/hoàn tất hồ sơ đã dùng để hai nơi luôn khớp quy tắc tuổi.
 */
export class SetBirthdateDto {
  @IsBirthdate(MIN_AGE_YEARS, {
    message: `Ngày sinh không hợp lệ hoặc bạn chưa đủ ${MIN_AGE_YEARS} tuổi.`,
  })
  birthdate: string;
}
