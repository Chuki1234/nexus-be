import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 32;
export const SEARCH_RESULT_LIMIT = 10;

const trimLower = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Query của GET /api/profiles/search — tìm người để mở trang hồ sơ của họ. */
export class SearchProfilesDto {
  @Transform(trimLower)
  @IsString({ message: 'Từ khoá không hợp lệ.' })
  @MinLength(SEARCH_MIN_LENGTH, {
    message: `Nhập ít nhất ${SEARCH_MIN_LENGTH} ký tự để tìm.`,
  })
  @MaxLength(SEARCH_MAX_LENGTH, { message: 'Từ khoá quá dài.' })
  q: string;
}
