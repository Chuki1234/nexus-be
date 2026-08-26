import { IsOptional, IsString, Length, Matches } from 'class-validator';

/** 6 chữ số TOTP từ Google Authenticator (hoặc backup code dạng xxxx-xxxx). */
export class VerifyTotpDto {
  @IsString()
  @Matches(/^[0-9]{6}$|^[0-9a-f]{8}$/, {
    message: 'code phải là 6 chữ số TOTP hoặc backup code 8 ký tự hex.',
  })
  code!: string;

  @IsOptional()
  @IsString()
  factorId?: string;
}

/** Dùng cho /auth/2fa/verify-login — xác thực TOTP sau bước đăng nhập mật khẩu. */
export class VerifyMfaChallengeDto {
  @IsString()
  @Length(1, 200)
  challengeId!: string;

  @IsString()
  @Matches(/^[0-9]{6}$|^[0-9a-f]{8}$/, {
    message: 'code phải là 6 chữ số TOTP hoặc backup code 8 ký tự hex.',
  })
  code!: string;

  /** Access token tạm AAL1 nhận được từ /login. */
  @IsString()
  @Length(1, 2048)
  accessToken!: string;
}

/** Dùng cho /auth/2fa/fast-login — đăng nhập nhanh bằng Google Authenticator. */
export class FastLoginDto {
  @IsString()
  @Length(1, 100)
  identifier!: string;

  @IsString()
  @Matches(/^[0-9]{6}$|^[0-9a-f]{8}$/, {
    message: 'code phải là 6 chữ số TOTP hoặc backup code 8 ký tự hex.',
  })
  code!: string;
}
