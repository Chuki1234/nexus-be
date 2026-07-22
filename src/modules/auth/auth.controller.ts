import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService, RegisteredUser } from './auth.service';
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
}
