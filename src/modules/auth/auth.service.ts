import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import type { Profile } from '../../shared/dto/auth';
import type {
  BackupCodesResponse,
  LoginMfaRequired,
  LoginResponse,
  TotpEnrollResponse,
  TotpStatusResponse,
} from '../../shared/dto/auth';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { FastLoginDto } from './dto/totp.dto';

export interface RegisteredUser {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
}

/** Hồ sơ trả về cho frontend. Không lộ cột nội bộ nào ngoài các trường này. */
export type ProfileView = Profile;

export type LoginSession = LoginResponse | LoginMfaRequired;

/** Mã lỗi Postgres cho vi phạm ràng buộc duy nhất. */
const UNIQUE_VIOLATION = '23505';

const INVALID_LOGIN = 'Email/tên đăng nhập hoặc mật khẩu không đúng.';
const UNRESOLVABLE_EMAIL = 'khong-ton-tai@nexus.invalid';
const BACKUP_CODE_COUNT = 8;

interface MfaChallengeRecord {
  userId: string;
  email: string;
  expiresAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly mfaChallenges = new Map<string, MfaChallengeRecord>();

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Tạo tài khoản: một bản ghi trong `auth.users` + một hồ sơ trong `public.profiles`.
   */
  async register(dto: RegisterDto): Promise<RegisteredUser> {
    const displayName = dto.displayName ?? null;

    const { data, error } = await this.supabase.client.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      user_metadata: { username: dto.username, display_name: displayName },
    });

    if (error) {
      if (error.code === 'email_exists' || error.status === 422) {
        throw new ConflictException('Email này đã được sử dụng.');
      }
      this.logger.error(`Tạo auth user thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không tạo được tài khoản. Vui lòng thử lại.',
      );
    }

    const userId = data.user.id;

    const { error: profileError } = await this.supabase.client
      .from('profiles')
      .insert({
        id: userId,
        username: dto.username,
        display_name: displayName,
        date_of_birth: dto.dateOfBirth,
      });

    if (profileError) {
      await this.rollbackUser(userId);

      if (profileError.code === UNIQUE_VIOLATION) {
        throw new ConflictException('Tên đăng nhập này đã có người dùng.');
      }
      this.logger.error(`Tạo hồ sơ thất bại: ${profileError.message}`);
      throw new InternalServerErrorException(
        'Không tạo được tài khoản. Vui lòng thử lại.',
      );
    }

    return {
      id: userId,
      email: dto.email,
      username: dto.username,
      displayName,
    };
  }

  /**
   * Đăng nhập bằng email HOẶC tên đăng nhập.
   * Nếu user bật 2FA, trả LoginMfaRequired thay vì session đầy đủ.
   */
  async login(dto: LoginDto): Promise<LoginSession> {
    const email =
      (await this.resolveEmail(dto.identifier)) ?? UNRESOLVABLE_EMAIL;

    const { data, error } =
      await this.supabase.authClient.auth.signInWithPassword({
        email,
        password: dto.password,
      });

    if (error || !data.session || !data.user) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    // Kiểm tra xem user có bật 2FA không
    const user = await this.getAdminUserById(data.user.id);
    const totpMeta = user?.app_metadata?.totp;

    if (totpMeta?.enabled && totpMeta?.secret) {
      // 2FA đang bật -> tạo challenge ID và yêu cầu nhập mã TOTP
      const challengeId = randomBytes(16).toString('hex');
      this.mfaChallenges.set(challengeId, {
        userId: data.user.id,
        email: data.user.email!,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      return {
        requiresMfa: true,
        mfaChallengeId: challengeId,
        accessToken: data.session.access_token,
      } satisfies LoginMfaRequired;
    }

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    } satisfies LoginResponse;
  }

  /**
   * Đăng nhập NHANH bằng Google Authenticator (không cần mật khẩu).
   * Nhận email/username + mã 6 số từ Google Authenticator (hoặc mã dự phòng).
   */
  async fastLoginTotp(dto: FastLoginDto): Promise<LoginResponse> {
    const email = await this.resolveEmail(dto.identifier);
    if (!email) {
      throw new UnauthorizedException('Email hoặc tên đăng nhập không tồn tại.');
    }

    const user = await this.getAdminUserByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Không tìm thấy tài khoản.');
    }

    const totpMeta = user.app_metadata?.totp;
    if (!totpMeta?.enabled || !totpMeta?.secret) {
      throw new UnauthorizedException(
        'Tài khoản này chưa kích hoạt Google Authenticator. Vui lòng đăng nhập bằng mật khẩu rồi vào Cài đặt để bật 2FA.',
      );
    }

    // Xác thực mã TOTP hoặc backup code
    const isCodeValid = await this.verifyTotpOrBackup(user, dto.code);
    if (!isCodeValid) {
      throw new UnauthorizedException('Mã Google Authenticator không đúng hoặc đã hết hạn.');
    }

    // Tạo phiên đăng nhập đầy đủ
    return this.createSessionForEmail(email);
  }

  /**
   * Xác thực TOTP sau bước đăng nhập mật khẩu thông thường.
   */
  async verifyLoginMfa(
    accessToken: string,
    challengeId: string,
    code: string,
  ): Promise<LoginResponse> {
    // 1. Kiểm tra challenge hoặc token
    const challenge = this.mfaChallenges.get(challengeId);
    let user: any = null;

    if (challenge && challenge.expiresAt > Date.now()) {
      user = await this.getAdminUserById(challenge.userId);
      this.mfaChallenges.delete(challengeId);
    } else {
      // Fallback: đọc user từ access token
      const { data } = await this.supabase.client.auth.getUser(accessToken);
      if (data?.user) {
        user = await this.getAdminUserById(data.user.id);
      }
    }

    if (!user) {
      throw new UnauthorizedException('Phiên xác thực đã hết hạn. Vui lòng đăng nhập lại.');
    }

    const isCodeValid = await this.verifyTotpOrBackup(user, code);
    if (!isCodeValid) {
      throw new UnauthorizedException('Mã xác thực không đúng hoặc đã hết hạn.');
    }

    return this.createSessionForEmail(user.email);
  }

  /**
   * Bắt đầu đăng ký TOTP — tạo secret chuẩn Base32 và QR Code PNG Data URL
   * để quét trực tiếp bằng ứng dụng Google Authenticator trên điện thoại.
   */
  async enrollTotp(userId: string): Promise<TotpEnrollResponse> {
    const user = await this.getAdminUserById(userId);
    if (!user) {
      throw new NotFoundException('Không tìm thấy thông tin tài khoản.');
    }

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'Nexus',
      label: user.email || user.user_metadata?.username || 'Nexus User',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    const qrCodeUrl = await QRCode.toDataURL(uri, {
      margin: 2,
      width: 220,
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    });

    // Lưu secret chờ xác nhận vào app_metadata
    await this.supabase.client.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...user.app_metadata,
        totp_pending: {
          secret: secret.base32,
          createdAt: new Date().toISOString(),
        },
      },
    });

    return {
      qrCodeUrl,
      secret: secret.base32,
      factorId: 'totp',
    };
  }

  /**
   * Xác nhận mã 6 số từ Google Authenticator -> Kích hoạt 2FA và tạo 8 mã dự phòng.
   */
  async verifyAndActivateTotp(
    userId: string,
    code: string,
  ): Promise<BackupCodesResponse> {
    const user = await this.getAdminUserById(userId);
    const pendingSecret = user?.app_metadata?.totp_pending?.secret;

    if (!pendingSecret) {
      throw new UnauthorizedException('Không có tiến trình cài đặt 2FA nào đang chờ. Vui lòng bấm Bật 2FA lại.');
    }

    const totp = new OTPAuth.TOTP({
      issuer: 'Nexus',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(pendingSecret),
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      throw new UnauthorizedException(
        'Mã xác thực không đúng. Vui lòng kiểm tra lại Google Authenticator.',
      );
    }

    // Tạo 8 mã dự phòng
    const rawCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const raw = randomBytes(4).toString('hex'); // 8 ký tự hex
      const hash = createHash('sha256').update(raw).digest('hex');
      rawCodes.push(raw);
      hashedCodes.push(hash);
    }

    // Cập nhật app_metadata: kích hoạt totp, lưu backup_codes, xoá pending
    const currentMeta = { ...user.app_metadata };
    delete currentMeta.totp_pending;

    await this.supabase.client.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...currentMeta,
        totp: {
          secret: pendingSecret,
          enabled: true,
          verified_at: new Date().toISOString(),
          backup_codes: hashedCodes,
        },
      },
    });

    return { codes: rawCodes };
  }

  /**
   * Tắt 2FA: xoá TOTP secret và backup codes khỏi tài khoản.
   */
  async unenrollTotp(userId: string): Promise<void> {
    const user = await this.getAdminUserById(userId);
    if (!user) return;

    const currentMeta = { ...user.app_metadata };
    delete currentMeta.totp;
    delete currentMeta.totp_pending;

    await this.supabase.client.auth.admin.updateUserById(userId, {
      app_metadata: currentMeta,
    });
  }

  /** Trạng thái 2FA của user. */
  async getTotpStatus(userId: string): Promise<TotpStatusResponse> {
    const user = await this.getAdminUserById(userId);
    const enabled = !!user?.app_metadata?.totp?.enabled;
    return {
      enabled,
      factorId: enabled ? 'totp' : null,
    };
  }

  /**
   * Tạo lại 8 mã dự phòng mới.
   */
  async regenerateBackupCodes(userId: string): Promise<BackupCodesResponse> {
    const user = await this.getAdminUserById(userId);
    if (!user) {
      throw new NotFoundException('Không tìm thấy thông tin tài khoản.');
    }
    const totp = user.app_metadata?.totp;

    if (!totp?.enabled) {
      throw new UnauthorizedException('2FA chưa được bật.');
    }

    const rawCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const raw = randomBytes(4).toString('hex');
      const hash = createHash('sha256').update(raw).digest('hex');
      rawCodes.push(raw);
      hashedCodes.push(hash);
    }

    await this.supabase.client.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...user.app_metadata,
        totp: {
          ...totp,
          backup_codes: hashedCodes,
        },
      },
    });

    return { codes: rawCodes };
  }

  /**
   * Hồ sơ của người đang đăng nhập.
   */
  async getProfile(userId: string): Promise<ProfileView | null> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, date_of_birth, email, avatar_url, banner_url, status_message')
      .eq('id', userId)
      .maybeSingle<{
        id: string;
        username: string;
        display_name: string | null;
        date_of_birth: string;
        email: string;
        avatar_url: string | null;
        banner_url: string | null;
        status_message: string | null;
      }>();

    if (error) {
      this.logger.error(`Đọc hồ sơ thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không đọc được hồ sơ. Vui lòng thử lại.',
      );
    }
    if (!data) {
      return null;
    }

    return {
      id: data.id,
      username: data.username,
      displayName: data.display_name,
      email: data.email,
      dateOfBirth: data.date_of_birth,
      avatarUrl: data.avatar_url ?? null,
      bannerColor: data.banner_url ?? null,
      customStatus: data.status_message ?? null,
    };
  }

  /**
   * Cập nhật thông tin hồ sơ người dùng (avatar, display name, banner, status).
   */
  async updateProfile(
    userId: string,
    dto: {
      displayName?: string | null;
      avatarUrl?: string | null;
      bannerColor?: string | null;
      customStatus?: string | null;
    },
  ): Promise<ProfileView> {
    const updatePayload: Record<string, unknown> = {};
    if (dto.displayName !== undefined) updatePayload.display_name = dto.displayName;
    if (dto.avatarUrl !== undefined) updatePayload.avatar_url = dto.avatarUrl;
    if (dto.bannerColor !== undefined) updatePayload.banner_url = dto.bannerColor;
    if (dto.customStatus !== undefined) updatePayload.status_message = dto.customStatus;

    if (Object.keys(updatePayload).length > 0) {
      const { error } = await this.supabase.client
        .from('profiles')
        .update(updatePayload)
        .eq('id', userId);

      if (error) {
        this.logger.error(`Cập nhật hồ sơ thất bại: ${error.message}`);
        throw new InternalServerErrorException(
          'Không cập nhật được hồ sơ. Vui lòng thử lại.',
        );
      }
    }

    const profile = await this.getProfile(userId);
    if (!profile) {
      throw new NotFoundException('Không tìm thấy hồ sơ người dùng.');
    }
    return profile;
  }

  /** Có '@' thì coi là email; ngược lại tra tên đăng nhập. Null nếu không có ai. */
  async resolveEmail(identifier: string): Promise<string | null> {
    if (identifier.includes('@')) {
      return identifier.toLowerCase().trim();
    }

    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('email')
      .eq('username', identifier.toLowerCase().trim())
      .maybeSingle<{ email: string }>();

    if (error) {
      this.logger.error(`Tra tên đăng nhập thất bại: ${error.message}`);
      return null;
    }
    return data?.email ?? null;
  }

  /**
   * Điền hồ sơ cho tài khoản đã đăng nhập bằng Google.
   */
  async completeProfile(
    user: { id: string; email: string | null },
    dto: CompleteProfileDto,
  ): Promise<RegisteredUser> {
    const displayName = dto.displayName ?? null;

    const { data: existing } = await this.supabase.client
      .from('profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    if (existing) {
      throw new ConflictException('Hồ sơ đã được tạo trước đó.');
    }

    const { error } = await this.supabase.client.from('profiles').insert({
      id: user.id,
      username: dto.username,
      display_name: displayName,
      date_of_birth: dto.dateOfBirth,
    });

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        throw new ConflictException('Tên đăng nhập này đã có người dùng.');
      }
      this.logger.error(`Tạo hồ sơ (complete) thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không lưu được hồ sơ. Vui lòng thử lại.',
      );
    }

    return {
      id: user.id,
      email: user.email ?? '',
      username: dto.username,
      displayName,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async getAdminUserById(userId: string) {
    const { data, error } = await this.supabase.client.auth.admin.getUserById(userId);
    if (error || !data.user) {
      return null;
    }
    return data.user;
  }

  private async getAdminUserByEmail(email: string) {
    const { data, error } = await this.supabase.client.auth.admin.listUsers();
    if (error || !data.users) return null;
    return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }

  private async verifyTotpOrBackup(user: any, code: string): Promise<boolean> {
    const cleanCode = code.trim().toLowerCase();
    const totpMeta = user?.app_metadata?.totp;
    if (!totpMeta?.secret) return false;

    // 1. Thử xác thực mã TOTP 6 số (window: 2 cho phép chênh lệch thời gian ±60s)
    if (/^[0-9]{6}$/.test(cleanCode)) {
      const totp = new OTPAuth.TOTP({
        issuer: 'Nexus',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(totpMeta.secret),
      });

      const delta = totp.validate({ token: cleanCode, window: 2 });
      if (delta !== null) {
        return true;
      }
    }

    // 2. Thử xác thực mã dự phòng (8 ký tự hex)
    if (/^[0-9a-f]{8}$/.test(cleanCode) && Array.isArray(totpMeta.backup_codes)) {
      const hash = createHash('sha256').update(cleanCode).digest('hex');
      const index = totpMeta.backup_codes.indexOf(hash);

      if (index !== -1) {
        // Đã khớp mã dự phòng -> loại bỏ mã đã dùng để không dùng lại được
        const updatedBackupCodes = [...totpMeta.backup_codes];
        updatedBackupCodes.splice(index, 1);

        await this.supabase.client.auth.admin.updateUserById(user.id, {
          app_metadata: {
            ...user.app_metadata,
            totp: {
              ...totpMeta,
              backup_codes: updatedBackupCodes,
            },
          },
        });
        return true;
      }
    }

    return false;
  }

  /**
   * Tạo phiên đăng nhập Supabase thực thụ cho email qua magiclink + verifyOtp.
   */
  private async createSessionForEmail(email: string): Promise<LoginResponse> {
    const { data: linkData, error: linkErr } =
      await this.supabase.client.auth.admin.generateLink({
        type: 'magiclink',
        email,
      });

    if (linkErr || !linkData?.properties?.hashed_token) {
      this.logger.error(`Tạo session qua generateLink thất bại: ${linkErr?.message}`);
      throw new InternalServerErrorException('Không tạo được phiên đăng nhập. Vui lòng thử lại.');
    }

    const { data: verifyData, error: verifyErr } =
      await this.supabase.authClient.auth.verifyOtp({
        token_hash: linkData.properties.hashed_token,
        type: 'email',
      });

    if (verifyErr || !verifyData.session) {
      this.logger.error(`verifyOtp thất bại: ${verifyErr?.message}`);
      throw new InternalServerErrorException('Không nạp được phiên đăng nhập. Vui lòng thử lại.');
    }

    return {
      accessToken: verifyData.session.access_token,
      refreshToken: verifyData.session.refresh_token,
      expiresAt: verifyData.session.expires_at ?? null,
    };
  }

  private async rollbackUser(userId: string): Promise<void> {
    const { error } = await this.supabase.client.auth.admin.deleteUser(userId);
    if (error) {
      this.logger.error(
        `Không xoá được auth user mồ côi ${userId}: ${error.message}`,
      );
    }
  }
}
