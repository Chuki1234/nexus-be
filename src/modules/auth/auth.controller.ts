import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { AuthService, RegisteredUser } from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * POST /api/auth/register
   *
   * Chỉ tạo tài khoản, không trả phiên đăng nhập: frontend tự gọi Supabase để
   * đăng nhập, giống hệt trang /login. Nhờ vậy backend không phải cầm token.
   *
   * TODO: gắn rate limit (@nestjs/throttler) trước khi lên production —
   * hiện endpoint này tạo tài khoản không giới hạn.
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<RegisteredUser> {
    return this.auth.register(dto);
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
