import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../guards/supabase-auth.guard';

/** Lấy access token đã được `SupabaseAuthGuard` xác thực và gắn vào request. */
export const AccessToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    return context.switchToHttp().getRequest<AuthenticatedRequest>().accessToken;
  },
);
