import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { AccessToken } from '../../common/decorators/access-token.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import type {
  BackupCodesResponse,
  TotpEnrollResponse,
  TotpStatusResponse,
} from '../../shared/dto/auth';
import { UnenrollDto, VerifyEnrollDto } from './dto/two-factor.dto';
import { TwoFactorService, type VerifyEnrollResult } from './two-factor.service';

/**
 * Quản lý 2FA (TOTP) trong Settings. Mọi endpoint cần đăng nhập; thao tác MFA
 * chạy thay mặt user bằng access token của họ (xem TwoFactorService).
 */
@Controller('auth/2fa')
@UseGuards(SupabaseAuthGuard)
export class TwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  /** GET /api/auth/2fa/status */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  status(@AccessToken() token: string): Promise<TotpStatusResponse> {
    return this.twoFactor.getStatus(token);
  }

  /** POST /api/auth/2fa/enroll — bắt đầu enroll, trả QR + secret. */
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  enroll(@AccessToken() token: string): Promise<TotpEnrollResponse> {
    return this.twoFactor.enroll(token);
  }

  /** POST /api/auth/2fa/verify-enroll — xác nhận mã, bật 2FA, trả backup codes + phiên AAL2. */
  @Post('verify-enroll')
  @HttpCode(HttpStatus.OK)
  verifyEnroll(
    @CurrentUser() user: User,
    @AccessToken() token: string,
    @Body() dto: VerifyEnrollDto,
  ): Promise<VerifyEnrollResult> {
    return this.twoFactor.verifyEnroll(token, user.id, dto.factorId, dto.code);
  }

  /** POST /api/auth/2fa/unenroll — tắt 2FA. */
  @Post('unenroll')
  @HttpCode(HttpStatus.OK)
  unenroll(
    @CurrentUser() user: User,
    @AccessToken() token: string,
    @Body() dto: UnenrollDto,
  ): Promise<{ success: true }> {
    return this.twoFactor.unenroll(token, user.id, dto.factorId);
  }

  /** POST /api/auth/2fa/regenerate-backup-codes — tạo lại bộ mã dự phòng. */
  @Post('regenerate-backup-codes')
  @HttpCode(HttpStatus.OK)
  regenerateBackupCodes(
    @CurrentUser() user: User,
    @AccessToken() token: string,
  ): Promise<BackupCodesResponse> {
    return this.twoFactor.regenerateBackupCodes(token, user.id);
  }
}
