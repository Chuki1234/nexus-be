import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body cho POST /auth/2fa/verify-enroll — xác nhận mã TOTP để bật 2FA. */
export class VerifyEnrollDto {
  @Transform(trim)
  @IsString({ message: 'Thiếu factorId.' })
  @MinLength(1, { message: 'Thiếu factorId.' })
  factorId: string;

  @Transform(trim)
  @IsString({ message: 'Vui lòng nhập mã xác thực.' })
  @Matches(/^\d{6}$/, { message: 'Mã TOTP gồm đúng 6 chữ số.' })
  code: string;
}

/** Body cho POST /auth/2fa/unenroll — tắt 2FA. */
export class UnenrollDto {
  @Transform(trim)
  @IsString({ message: 'Thiếu factorId.' })
  @MinLength(1, { message: 'Thiếu factorId.' })
  @MaxLength(200, { message: 'factorId không hợp lệ.' })
  factorId: string;
}
