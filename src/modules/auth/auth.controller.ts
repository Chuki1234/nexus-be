import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import type { LoginMfaRequired, LoginResponse } from '../../shared/dto/auth';
import { USERNAME_PATTERN } from '../../shared/dto/auth';
import {
  AuthService,
  LoginSession,
  ProfileView,
  RegisteredUser,
} from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { FastLoginDto, VerifyLoginDto } from './dto/two-factor.dto';
import { TwoFactorService } from './two-factor.service';

/** Đủ cho người gõ nhầm vài lần, không đủ để dò mật khẩu. */
const STRICT_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };
const CHECK_USERNAME_LIMIT = { default: { limit: 60, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  /**
   * GET /api/auth/check-username?username=...
   *
   * Kiểm tra tên đăng nhập đã được dùng chưa theo thời gian thực.
   */
  @Get('check-username')
  @HttpCode(HttpStatus.OK)
  @Throttle(CHECK_USERNAME_LIMIT)
  async checkUsername(
    @Query('username') username: string,
  ): Promise<{ available: boolean }> {
    if (!username || typeof username !== 'string') {
      return { available: false };
    }
    const clean = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(clean)) {
      return { available: false };
    }
    const isTaken = await this.auth.isUsernameTaken(clean);
    return { available: !isTaken };
  }

  /**
   * POST /api/auth/register
   *
   * Chỉ tạo tài khoản, không trả phiên đăng nhập: frontend gọi tiếp /auth/login.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<RegisteredUser> {
    return this.auth.register(dto);
  }

  /**
   * POST /api/auth/login
   *
   * Nhận email HOẶC tên đăng nhập. Phải chạy ở backend vì tra tên đăng nhập cần
   * đọc bảng `profiles` — frontend không được phép đọc bảng (NEXUS_CONTEXT §3.4).
   *
   * Trả token về cho frontend tự nạp vào Supabase client bằng `setSession`.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginSession | LoginMfaRequired> {
    return this.auth.login(dto);
  }

  /**
   * POST /api/auth/2fa/verify-login — bước 2 khi đăng nhập với 2FA.
   *
   * Public (user chưa hoàn tất đăng nhập): nhận access token AAL1 + challengeId +
   * mã (TOTP hoặc backup) trong body, trả phiên đầy đủ. Throttle như /login.
   */
  @Post('2fa/verify-login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_RATE_LIMIT)
  verifyLogin(@Body() dto: VerifyLoginDto): Promise<LoginResponse> {
    return this.twoFactor.verifyLogin(dto.accessToken, dto.challengeId, dto.code);
  }

  /**
   * POST /api/auth/2fa/fast-login — đăng nhập nhanh KHÔNG mật khẩu bằng mã dự
   * phòng 2FA. Public, throttle chặt như /login.
   */
  @Post('2fa/fast-login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_RATE_LIMIT)
  fastLogin(@Body() dto: FastLoginDto): Promise<LoginResponse> {
    return this.auth.fastLoginBackup(dto.identifier, dto.code);
  }

  /**
   * GET /api/auth/me
   *
   * `profile` là null khi tài khoản chưa hoàn tất hồ sơ (đăng nhập Google lần đầu).
   * Frontend dựa vào đây thay vì tự đọc bảng `profiles`.
   */
  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  async me(
    @CurrentUser() user: User,
  ): Promise<{ profile: ProfileView | null }> {
    return { profile: await this.auth.getProfile(user.id, user.email ?? null) };
  }

  /**
   * POST /api/auth/complete-profile
   *
   * Dành cho tài khoản đăng nhập bằng Google/SĐT: `auth.users` đã có sẵn nhưng
   * chưa có hồ sơ `profiles`. `SupabaseAuthGuard` xác thực access token rồi cho
   * biết đây là ai — client không tự khai id được.
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

  /** Xóa vĩnh viễn tài khoản của chính người đang đăng nhập. */
  @Delete('account')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SupabaseAuthGuard)
  async deleteAccount(
    @CurrentUser() user: User,
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    await this.auth.deleteAccount(user, dto.email);
  }
}
