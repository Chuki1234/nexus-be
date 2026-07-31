import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import {
  AuthService,
  LoginSession,
  ProfileView,
  RegisteredUser,
} from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/** Đủ cho người gõ nhầm vài lần, không đủ để dò mật khẩu. */
const STRICT_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

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
   * Nhận email HOẶC tên đăng nhập. Phải chạy ở backend vì tra tên đăng nhập cần
   * đọc bảng `profiles` — frontend không được phép đọc bảng (NEXUS_CONTEXT §3.4).
   *
   * Trả token về cho frontend tự nạp vào Supabase client bằng `setSession`.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(STRICT_RATE_LIMIT)
  login(@Body() dto: LoginDto): Promise<LoginSession> {
    return this.auth.login(dto);
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
    return { profile: await this.auth.getProfile(user.id) };
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
}
