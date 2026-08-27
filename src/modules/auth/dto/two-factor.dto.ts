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

/** Body cho POST /auth/2fa/fast-login — đăng nhập nhanh bằng mã dự phòng (public). */
export class FastLoginDto {
  @Transform(trim)
  @MaxLength(254, { message: 'Email hoặc tên đăng nhập quá dài.' })
  @IsString({ message: 'Vui lòng nhập email hoặc tên đăng nhập.' })
  @MinLength(1, { message: 'Vui lòng nhập email hoặc tên đăng nhập.' })
  identifier: string;

  @Transform(trim)
  @IsString({ message: 'Vui lòng nhập mã dự phòng.' })
  @MinLength(6, { message: 'Mã dự phòng không hợp lệ.' })
  @MaxLength(20, { message: 'Mã dự phòng không hợp lệ.' })
  code: string;
}

/** Body cho POST /auth/2fa/verify-login — bước 2 khi đăng nhập (public). */
export class VerifyLoginDto {
  @Transform(trim)
  @IsString({ message: 'Thiếu access token.' })
  @MinLength(1, { message: 'Thiếu access token.' })
  accessToken: string;

  @Transform(trim)
  @IsString({ message: 'Thiếu challengeId.' })
  @MinLength(1, { message: 'Thiếu challengeId.' })
  challengeId: string;

  // Chấp nhận cả TOTP 6 số lẫn mã dự phòng (định dạng do service tự phân biệt).
  @Transform(trim)
  @IsString({ message: 'Vui lòng nhập mã xác thực.' })
  @MinLength(6, { message: 'Mã xác thực quá ngắn.' })
  @MaxLength(20, { message: 'Mã xác thực không hợp lệ.' })
  code: string;
}

/** Body cho POST /auth/2fa/unenroll — tắt 2FA. */
export class UnenrollDto {
  @Transform(trim)
  @IsString({ message: 'Thiếu factorId.' })
  @MinLength(1, { message: 'Thiếu factorId.' })
  @MaxLength(200, { message: 'factorId không hợp lệ.' })
  factorId: string;

  @Transform(trim)
  @IsString({ message: 'Vui lòng nhập mã xác thực từ Google Authenticator.' })
  @MinLength(6, { message: 'Mã xác thực phải có ít nhất 6 ký tự.' })
  @MaxLength(20, { message: 'Mã xác thực không hợp lệ.' })
  code: string;
}
