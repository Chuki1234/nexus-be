import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import type {
  BackupCodesResponse,
  LoginResponse,
  LoginResult,
  TotpEnrollResponse,
  TotpStatusResponse,
} from '../../shared/dto/auth';
import {
  AuthService,
  ProfileView,
  RegisteredUser,
} from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { FastLoginDto, VerifyMfaChallengeDto, VerifyTotpDto } from './dto/totp.dto';

/** Đủ cho người gõ nhầm vài lần, không đủ để dò mật khẩu. */
const STRICT_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };
/** Rate limit cho các hành động 2FA. */
const MFA_RATE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * POST /api/auth/register
   *
   * Chỉ tạo tài khoản, không trả phiên đăng nhập: frontend gọi tiếp /auth/login.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle(STRICT_RATE_LIMIT)
  register(@Body() dto: RegisterDto): Promise<RegisteredUser> {
    return this.auth.register(dto);
  }

  /**
   * POST /api/auth/login
   *
   * Nhận email HOẶC tên đăng nhập.
   * Trả `LoginResponse` (session đầy đủ) nếu không có 2FA, hoặc `LoginMfaRequired`
   * (requiresMfa: true + challengeId) nếu user đã bật 2FA.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_RATE_LIMIT)
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }

  /**
   * POST /api/auth/2fa/fast-login
   *
   * Đăng nhập nhanh bằng Google Authenticator (không cần nhập mật khẩu).
   * Nhận identifier (email/username) + mã 6 số từ Google Authenticator (hoặc mã dự phòng).
   */
  @Post('2fa/fast-login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_RATE_LIMIT)
  fastLogin(@Body() dto: FastLoginDto): Promise<LoginResponse> {
    return this.auth.fastLoginTotp(dto);
  }

  /**
   * GET /api/auth/me
   *
   * `profile` là null khi tài khoản chưa hoàn tất hồ sơ (đăng nhập Google lần đầu).
   */
  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  async me(
    @CurrentUser() user: User,
  ): Promise<{ profile: ProfileView | null }> {
    return { profile: await this.auth.getProfile(user.id) };
  }

  /**
   * POST /api/auth/complete-profile
   */
  @Post('complete-profile')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SupabaseAuthGuard)
  completeProfile(
    @CurrentUser() user: User,
    @Body() dto: CompleteProfileDto,
  ): Promise<RegisteredUser> {
    return this.auth.completeProfile(
      { id: user.id, email: user.email ?? null },
      dto,
    );
  }

  /**
   * PATCH /api/auth/profile
   *
   * Cập nhật ảnh đại diện, tên hiển thị, banner, trạng thái...
   */
  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    return this.auth.updateProfile(user.id, dto);
  }

  // ─── 2FA / TOTP ─────────────────────────────────────────────────────────────

  /**
   * POST /api/auth/2fa/verify-login
   *
   * Bước 2 của login khi 2FA bật.
   */
  @Post('2fa/verify-login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_RATE_LIMIT)
  verifyLoginMfa(@Body() dto: VerifyMfaChallengeDto): Promise<LoginResponse> {
    return this.auth.verifyLoginMfa(dto.accessToken, dto.challengeId, dto.code);
  }

  /**
   * GET /api/auth/2fa/status
   *
   * Trả trạng thái 2FA của user hiện tại.
   */
  @Get('2fa/status')
  @UseGuards(SupabaseAuthGuard)
  @Throttle(MFA_RATE_LIMIT)
  getTotpStatus(
    @CurrentUser() user: User,
  ): Promise<TotpStatusResponse> {
    return this.auth.getTotpStatus(user.id);
  }

  /**
   * POST /api/auth/2fa/enroll
   *
   * Bắt đầu đăng ký TOTP — tạo secret chuẩn Base32 + QR code Data URL.
   */
  @Post('2fa/enroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @Throttle(MFA_RATE_LIMIT)
  enrollTotp(@CurrentUser() user: User): Promise<TotpEnrollResponse> {
    return this.auth.enrollTotp(user.id);
  }

  /**
   * POST /api/auth/2fa/verify-enroll
   *
   * Xác nhận mã 6 số từ Google Authenticator — kích hoạt 2FA và tạo 8 mã dự phòng.
   */
  @Post('2fa/verify-enroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @Throttle(STRICT_RATE_LIMIT)
  verifyEnrollTotp(
    @CurrentUser() user: User,
    @Body() body: VerifyTotpDto,
  ): Promise<BackupCodesResponse> {
    return this.auth.verifyAndActivateTotp(user.id, body.code);
  }

  /**
   * POST /api/auth/2fa/unenroll
   *
   * Tắt 2FA: xoá TOTP factor và backup codes.
   */
  @Post('2fa/unenroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @Throttle(STRICT_RATE_LIMIT)
  unenrollTotp(@CurrentUser() user: User): Promise<void> {
    return this.auth.unenrollTotp(user.id);
  }

  /**
   * POST /api/auth/2fa/regenerate-backup-codes
   *
   * Tạo lại 8 mã dự phòng mới.
   */
  @Post('2fa/regenerate-backup-codes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  @Throttle(STRICT_RATE_LIMIT)
  regenerateBackupCodes(
    @CurrentUser() user: User,
  ): Promise<BackupCodesResponse> {
    return this.auth.regenerateBackupCodes(user.id);
  }
}
