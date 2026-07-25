import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../../infra/supabase/supabase.service';

/** Request đã qua guard mang theo user Supabase đã xác thực. */
export interface AuthenticatedRequest extends Request {
  user: User;
}

/**
 * Chặn endpoint cho tới khi có `Authorization: Bearer <access_token>` hợp lệ.
 *
 * Không tự giải mã JWT: đưa token cho Supabase `auth.getUser(jwt)` để chính máy
 * chủ auth xác nhận chữ ký và hạn dùng. Frontend lấy token này từ phiên hiện tại
 * (đăng nhập bằng Google, SĐT hay email đều có access_token như nhau).
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Thiếu access token.');
    }

    const { data, error } = await this.supabase.client.auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }

    request.user = data.user;
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }
    const [scheme, value] = header.split(' ');
    return scheme === 'Bearer' && value ? value : null;
  }
}
