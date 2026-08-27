import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { statusExpiryFor } from '../../common/utils/status-ttl.util';
import type { LoginMfaRequired, LoginResponse, Profile } from '../../shared/dto/auth';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TwoFactorService } from './two-factor.service';

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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly twoFactor: TwoFactorService,
  ) {}

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
        birthdate: dto.dateOfBirth,
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
  async login(dto: LoginDto): Promise<LoginSession | LoginMfaRequired> {
    const cleanIdentifier = dto.identifier.trim();
    const email =
      (await this.resolveEmail(cleanIdentifier)) ?? UNRESOLVABLE_EMAIL;

    const { data, error } =
      await this.supabase.authClient.auth.signInWithPassword({
        email,
        password: dto.password,
      });

    if (error || !data.session || !data.user) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    // Đúng mật khẩu nhưng user có TOTP đã bật: phiên này mới ở AAL1. KHÔNG trả
    // session — bắt qua bước nhập mã. Tạo challenge và trả token AAL1 tạm để
    // /auth/2fa/verify-login dùng.
    const factorId = (data.user?.factors ?? []).find(
      (f) => f.factor_type === 'totp' && f.status === 'verified',
    )?.id;

    if (factorId) {
      const mfaChallengeId = await this.twoFactor.challengeForLogin(
        data.session.access_token,
        factorId,
      );
      return {
        requiresMfa: true,
        mfaChallengeId,
        accessToken: data.session.access_token,
      };
    }

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
    } satisfies LoginResponse;
  }

  /**
   * Hồ sơ của người đang đăng nhập.
   * `email` không nằm trong bảng `profiles` (chỉ Auth mới có) nên lấy từ
   * token của người gọi thay vì select thêm một cột không tồn tại.
   */
  async getProfile(userId: string, email?: string | null): Promise<ProfileView | null> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle<any>();

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
      displayName: data.display_name ?? null,
      email: email ?? data.email ?? '',
      dateOfBirth: data.birthdate ?? data.date_of_birth ?? '',
      avatarUrl: data.avatar_url ?? null,
      bannerColor: data.banner_url ?? data.banner_color ?? null,
      customStatus: data.status_message ?? data.custom_status ?? null,
    };
  }

  /**
   * Đăng nhập nhanh KHÔNG mật khẩu bằng MÃ DỰ PHÒNG 2FA.
   *
   * Supabase không cho verify TOTP mà không có phiên (mà phiên chỉ tạo bằng mật
   * khẩu), nên fast-login chỉ nhận mã dự phòng — thứ backend tự quản được. Quy
   * trình: resolve identifier → lấy user qua admin magic link → verify+tiêu mã
   * dự phòng → nếu đúng thì đổi token magic link lấy phiên thật. Mọi lỗi trả
   * cùng một câu chung, không tiết lộ identifier nào tồn tại.
   */
  async fastLoginBackup(identifier: string, code: string): Promise<LoginSession> {
    const email = await this.resolveEmail(identifier.trim());
    if (!email) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    // Sinh magic link (không gửi email) để lấy user id + token đổi phiên.
    const { data: link, error: linkError } =
      await this.supabase.client.auth.admin.generateLink({
        type: 'magiclink',
        email,
      });
    if (linkError || !link.user || !link.properties?.hashed_token) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    // Đổi token magic link lấy session AAL1 trước
    const { data: session, error: verifyError } =
      await this.supabase.authClient.auth.verifyOtp({
        token_hash: link.properties.hashed_token,
        type: 'email',
      });
    if (verifyError || !session.session) {
      throw new UnauthorizedException(INVALID_LOGIN);
    }

    const normalized = code.trim();
    const isTotp = /^\d{6}$/.test(normalized);

    if (isTotp) {
      const factor = (link.user.factors ?? []).find(
        (f) => f.factor_type === 'totp' && f.status === 'verified',
      );
      if (factor) {
        try {
          const challengeId = await this.twoFactor.challengeForLogin(
            session.session.access_token,
            factor.id,
          );
          const verified = await this.twoFactor.verifyLogin(
            session.session.access_token,
            challengeId,
            normalized,
          );
          return {
            accessToken: verified.accessToken,
            refreshToken: verified.refreshToken,
            expiresAt: verified.expiresAt,
          };
        } catch {
          throw new UnauthorizedException('Mã xác thực Google Authenticator không đúng hoặc đã hết hạn.');
        }
      }
    }

    // Mã dự phòng
    const ok = await this.twoFactor.verifyBackupCode(link.user.id, normalized);
    if (!ok) {
      throw new UnauthorizedException('Mã xác thực 2FA hoặc mã dự phòng không đúng.');
    }

    return {
      accessToken: session.session.access_token,
      refreshToken: session.session.refresh_token,
      expiresAt: session.session.expires_at ?? null,
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
    if (dto.customStatus !== undefined) {
      // Đồng bộ với ProfilesService: status tuỳ chỉnh tự hết hạn sau 24h.
      updatePayload.status_message = dto.customStatus;
      updatePayload.status_message_expires_at = statusExpiryFor(dto.customStatus);
    }

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
  private async resolveEmail(identifier: string): Promise<string | null> {
    const clean = identifier.trim().toLowerCase();
    if (clean.includes('@')) {
      return clean;
    }

    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('email')
      .eq('username', clean)
      .maybeSingle<{ email: string }>();

    if (error) {
      this.logger.error(`Tra tên đăng nhập thất bại: ${error.message}`);
      return null;
    }
    return data?.email ?? null;
  }

  /** Kiểm tra xem tên đăng nhập đã được ai sử dụng chưa. */
  async isUsernameTaken(username: string): Promise<boolean> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();

    if (error) {
      this.logger.error(`Kiểm tra tên đăng nhập thất bại: ${error.message}`);
      return false;
    }
    return !!data;
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
      birthdate: dto.dateOfBirth,
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

  /**
   * Xóa auth user trước; khóa ngoại của dữ liệu thuộc người dùng phải cascade.
   * Dọn hồ sơ lần nữa để tương thích với môi trường cũ chưa bật cascade.
   */
  async deleteAccount(user: User, confirmationEmail: string): Promise<void> {
    if (!user.email || user.email.toLowerCase() !== confirmationEmail.toLowerCase()) {
      throw new UnauthorizedException('Email xác nhận không khớp với tài khoản hiện tại.');
    }

    const { error } = await this.supabase.client.auth.admin.deleteUser(user.id);
    if (error) {
      this.logger.error(`Xóa tài khoản ${user.id} thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không xóa được tài khoản. Vui lòng thử lại.',
      );
    }

    const { error: profileError } = await this.supabase.client
      .from('profiles')
      .delete()
      .eq('id', user.id);
    if (profileError) {
      this.logger.warn(`Không dọn được hồ sơ ${user.id}: ${profileError.message}`);
    }
  }

  private async rollbackUser(userId: string): Promise<void> {
    const { error } = await this.supabase.client.auth.admin.deleteUser(userId);
    if (error) {
      this.logger.error(
        `Không xoá được auth user mồ côi ${userId}: ${error.message}`,
      );
    }
  }

  async verifyCurrentPassword(user: User, password: string): Promise<boolean> {
    if (!password || !user.email) return false;
    try {
      const { data, error } = await this.supabase.authClient.auth.signInWithPassword({
        email: user.email,
        password: password,
      });
      return !error && !!data?.session;
    } catch {
      return false;
    }
  }

  async changePassword(
    user: User,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!user.email) {
      throw new BadRequestException('Tài khoản không có email xác thực.');
    }
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Mật khẩu mới phải có ít nhất 8 ký tự.');
    }

    const isValid = await this.verifyCurrentPassword(user, currentPassword);
    if (!isValid) {
      throw new BadRequestException('Mật khẩu hiện tại không chính xác.');
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException('Mật khẩu mới không được trùng với mật khẩu hiện tại.');
    }

    const { error } = await this.supabase.client.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });

    if (error) {
      this.logger.error(`Đổi mật khẩu thất bại: ${error.message}`);
      throw new InternalServerErrorException('Không thể cập nhật mật khẩu mới.');
    }

    return { success: true, message: 'Đổi mật khẩu thành công.' };
  }
}
