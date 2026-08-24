import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import type { User } from '@supabase/supabase-js';
import type { LoginMfaRequired, Profile } from '../../shared/dto/auth';
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

export interface LoginSession {
  accessToken: string;
  refreshToken: string;
  /** Giây Unix. Null nếu Supabase không trả về. */
  expiresAt: number | null;
}

/** Mã lỗi Postgres cho vi phạm ràng buộc duy nhất. */
const UNIQUE_VIOLATION = '23505';

/**
 * Câu duy nhất trả về cho MỌI kiểu đăng nhập hỏng.
 *
 * Không được tách thành "tài khoản không tồn tại" / "sai mật khẩu" / "chưa xác
 * nhận email": chênh lệch đó đủ để dò xem một email hay tên đăng nhập đã có
 * người dùng hay chưa.
 */
const INVALID_LOGIN = 'Email/tên đăng nhập hoặc mật khẩu không đúng.';

/**
 * Email không thể tồn tại (TLD `.invalid` được RFC 2606 dành riêng).
 *
 * Khi không tra ra tên đăng nhập, vẫn gọi Supabase bằng địa chỉ này thay vì trả
 * lỗi ngay: hai nhánh chạy cùng một lượng việc nên thời gian phản hồi không tố
 * cáo tài khoản có tồn tại hay không.
 */
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
   *
   * Hai bước này không nằm chung transaction được (một bên là Admin API, một bên
   * là Postgres), nên nếu bước hai hỏng thì phải xoá tay bản ghi ở bước một —
   * xem `rollbackUser`.
   */
  async register(dto: RegisterDto): Promise<RegisteredUser> {
    const displayName = dto.displayName ?? null;

    const { data, error } = await this.supabase.client.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      // Dự án chưa cấu hình SMTP nên không gửi được thư xác nhận; đánh dấu đã
      // xác nhận để người dùng đăng nhập được ngay. Khi bật SMTP thì bỏ dòng này
      // và cho frontend hiện màn "kiểm tra hộp thư" thay vì tự đăng nhập.
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
      // Không để lại auth user mồ côi: email đó sẽ vừa không đăng ký lại được
      // (đã tồn tại) vừa không dùng được (thiếu hồ sơ).
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
   *
   * Việc đổi tên đăng nhập thành email phải nằm ở đây, không được tách thành một
   * endpoint riêng cho frontend gọi: một endpoint "tên đăng nhập này có tồn tại
   * không" chính là công cụ dò tài khoản.
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

    if (error || !data.session) {
      // Cố tình không phân loại lỗi: mọi nguyên nhân đều ra cùng một câu.
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
    };
  }

  /**
   * Hồ sơ của người đang đăng nhập, hoặc null nếu chưa tạo.
   *
   * Frontend không được tự đọc bảng `profiles` (NEXUS_CONTEXT §3.4), nên đây là
   * đường duy nhất để biết "tài khoản này đã hoàn tất hồ sơ chưa" — thứ mà
   * `profileGuard` cần trước mỗi trang.
   *
   * Trả null thay vì ném 404: chưa có hồ sơ là trạng thái bình thường của tài
   * khoản Google mới, không phải lỗi.
   */
  /**
   * `email` không nằm trong bảng `profiles` (chỉ Auth mới có) nên lấy từ
   * token của người gọi thay vì select thêm một cột không tồn tại.
   */
  async getProfile(userId: string, email: string | null): Promise<ProfileView | null> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, birthdate')
      .eq('id', userId)
      .maybeSingle<{
        id: string;
        username: string;
        display_name: string | null;
        birthdate: string;
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
      email: email ?? '',
      dateOfBirth: data.birthdate,
    };
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
   *
   * `auth.users` đã do Supabase tạo lúc OAuth/OTP, nên ở đây chỉ ghi `profiles`.
   * Không có bước rollback: nếu ghi hồ sơ hỏng, tài khoản auth vẫn dùng lại được
   * và người dùng chỉ cần thử hoàn tất hồ sơ lại.
   */
  async completeProfile(
    user: { id: string; email: string | null },
    dto: CompleteProfileDto,
  ): Promise<RegisteredUser> {
    const displayName = dto.displayName ?? null;

    // Một tài khoản chỉ có một hồ sơ. Chặn ở đây để không nuốt lỗi trùng khoá
    // chính (id) thành "trùng tên đăng nhập" gây khó hiểu.
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
      // Không ném tiếp: lỗi thật sự cần báo cho người dùng là lỗi tạo hồ sơ.
      this.logger.error(
        `Không xoá được auth user mồ côi ${userId}: ${error.message}`,
      );
    }
  }
}
