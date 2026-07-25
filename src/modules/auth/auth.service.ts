import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { RegisterDto } from './dto/register.dto';

export interface RegisteredUser {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
}

/** Mã lỗi Postgres cho vi phạm ràng buộc duy nhất. */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly supabase: SupabaseService) {}

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
        birthdate: dto.birthdate,
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
   * Điền hồ sơ cho tài khoản đã đăng nhập bằng Google/SĐT.
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
      birthdate: dto.birthdate,
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
