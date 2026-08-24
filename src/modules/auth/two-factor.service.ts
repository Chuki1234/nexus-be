import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import type {
  BackupCodesResponse,
  TotpEnrollResponse,
  TotpStatusResponse,
} from '../../shared/dto/auth';

/** Số mã dự phòng phát mỗi lần bật 2FA / regenerate. */
const BACKUP_CODE_COUNT = 10;

/** Session mới (AAL2) GoTrue trả về sau khi verify TOTP thành công. */
interface GotrueSession {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
}

interface EnrollResult {
  id: string;
  totp: { qr_code: string; secret: string; uri: string };
}

/**
 * FE hiển thị QR bằng `<img [src]="qrCodeUrl">`, nên phải là ẢNH chứ không phải
 * chuỗi `otpauth://`. GoTrue trả `totp.qr_code` là SVG (có bản là data-URI sẵn,
 * có bản là SVG thô) — chuẩn hoá về data-URI để `<img>` luôn render được.
 */
function toImageDataUri(qrCode: string): string {
  if (!qrCode) return qrCode;
  if (qrCode.startsWith('data:') || qrCode.startsWith('http')) return qrCode;
  return `data:image/svg+xml;utf-8,${encodeURIComponent(qrCode)}`;
}

interface ChallengeResult {
  id: string;
}

/** Thân verify-enroll: backup codes + phiên AAL2 để client nạp lại. */
export type VerifyEnrollResult = BackupCodesResponse & {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
};

/**
 * 2FA (TOTP) qua Supabase MFA + mã dự phòng tự quản.
 *
 * Supabase MFA là thao tác THEO PHIÊN user, không phải service_role — nên gọi
 * thẳng GoTrue REST (`/auth/v1/factors...`) bằng access token của user. Backup
 * codes Supabase không có sẵn nên tự sinh, hash sha-256 lưu bảng `mfa_backup_codes`.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Gọi GoTrue REST thay mặt user (dùng Bearer token của họ). */
  private async gotrue<T>(
    path: string,
    method: 'POST' | 'DELETE',
    accessToken: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.supabase.url}/auth/v1${path}`, {
      method,
      headers: {
        apikey: this.supabase.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const err = data as { msg?: string; error_description?: string; message?: string };
      const message = err.msg || err.error_description || err.message || 'Thao tác 2FA thất bại.';
      this.logger.warn(`GoTrue ${method} ${path} → ${res.status}: ${message}`);
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
      }
      throw new BadRequestException(message);
    }

    return data as T;
  }

  /** Trạng thái 2FA: đã bật chưa + factorId (đọc factors từ getUser). */
  async getStatus(accessToken: string): Promise<TotpStatusResponse> {
    const { data, error } = await this.supabase.client.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }
    const factor = (data.user.factors ?? []).find(
      (f) => f.factor_type === 'totp' && f.status === 'verified',
    );
    return { enabled: Boolean(factor), factorId: factor?.id ?? null };
  }

  /** Bắt đầu enroll TOTP — trả QR URI + secret + factorId (chưa bật cho tới verify). */
  async enroll(accessToken: string): Promise<TotpEnrollResponse> {
    const status = await this.getStatus(accessToken);
    if (status.enabled) {
      throw new ConflictException('2FA đã được bật cho tài khoản này.');
    }

    // Dọn các factor TOTP chưa verify còn sót (vd enroll dở rồi bỏ) — nếu không
    // GoTrue báo "factor already exists" ở lần enroll sau.
    const { data } = await this.supabase.client.auth.getUser(accessToken);
    for (const f of data.user?.factors ?? []) {
      if (f.factor_type === 'totp' && f.status !== 'verified') {
        await this.gotrue(`/factors/${f.id}`, 'DELETE', accessToken).catch(() => undefined);
      }
    }

    const res = await this.gotrue<EnrollResult>('/factors', 'POST', accessToken, {
      factor_type: 'totp',
      friendly_name: 'Nexus Authenticator',
    });

    return {
      qrCodeUrl: toImageDataUri(res.totp.qr_code),
      secret: res.totp.secret,
      factorId: res.id,
    };
  }

  /**
   * Xác nhận mã TOTP để bật 2FA. Thành công thì phiên lên AAL2 và phát backup codes.
   */
  async verifyEnroll(
    accessToken: string,
    userId: string,
    factorId: string,
    code: string,
  ): Promise<VerifyEnrollResult> {
    const challenge = await this.gotrue<ChallengeResult>(
      `/factors/${factorId}/challenge`,
      'POST',
      accessToken,
    );

    const session = await this.gotrue<GotrueSession>(
      `/factors/${factorId}/verify`,
      'POST',
      accessToken,
      { challenge_id: challenge.id, code },
    );

    const codes = await this.generateBackupCodes(userId);

    return {
      codes,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ?? null,
    };
  }

  /** Tắt 2FA: gỡ factor + xoá backup codes. */
  async unenroll(accessToken: string, userId: string, factorId: string): Promise<{ success: true }> {
    await this.gotrue(`/factors/${factorId}`, 'DELETE', accessToken);
    await this.deleteBackupCodes(userId);
    return { success: true };
  }

  /** Tạo lại bộ backup codes mới (yêu cầu 2FA đang bật). */
  async regenerateBackupCodes(accessToken: string, userId: string): Promise<BackupCodesResponse> {
    const status = await this.getStatus(accessToken);
    if (!status.enabled) {
      throw new BadRequestException('Chưa bật 2FA nên không có mã dự phòng để tạo lại.');
    }
    const codes = await this.generateBackupCodes(userId);
    return { codes };
  }

  /** Sinh mã mới, xoá bộ cũ, lưu hash. Trả mã gốc (chỉ hiện một lần). */
  private async generateBackupCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => this.randomCode());

    await this.deleteBackupCodes(userId);

    const rows = codes.map((code) => ({ user_id: userId, code_hash: this.hashCode(code) }));
    const { error } = await this.supabase.client.from('mfa_backup_codes').insert(rows);
    if (error) {
      this.logger.error(`Lưu backup codes thất bại: ${error.message}`);
      throw new InternalServerErrorException('Không tạo được mã dự phòng.');
    }

    return codes;
  }

  private async deleteBackupCodes(userId: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('mfa_backup_codes')
      .delete()
      .eq('user_id', userId);
    if (error) {
      this.logger.error(`Xoá backup codes thất bại: ${error.message}`);
      throw new InternalServerErrorException('Không dọn được mã dự phòng cũ.');
    }
  }

  /** Mã dạng `A1B2-C3D4` — dễ đọc, đủ entropy (4 byte ngẫu nhiên). */
  private randomCode(): string {
    const raw = randomBytes(4).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  }

  /** Hash để so khi verify — bỏ dấu gạch, chuẩn hoá hoa. */
  private hashCode(code: string): string {
    const normalized = code.replace(/-/g, '').toUpperCase();
    return createHash('sha256').update(normalized).digest('hex');
  }
}
