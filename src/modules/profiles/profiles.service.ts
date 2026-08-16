import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MediaService,
  ProfileImageKind,
} from '../../infra/storage/media.service';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { SEARCH_RESULT_LIMIT } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

export interface ProfileLink {
  label: string;
  url: string;
}

/** Phần hồ sơ ai đăng nhập cũng xem được. */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  statusMessage: string | null;
  bio: string | null;
  location: string | null;
  links: ProfileLink[];
  /** Màu accent người dùng tự chọn. `null` = tự động (băm từ username). */
  accentColor: string | null;
  createdAt: string;
  /** True khi người xem chính là chủ hồ sơ — frontend dựa vào đây để hiện nút sửa. */
  isSelf: boolean;
}

/** Hồ sơ của chính mình: có thêm trường không công khai. */
export interface OwnProfile extends PublicProfile {
  /** Định dạng `YYYY-MM-DD`. Không trả về trong hồ sơ của người khác. */
  birthdate: string;
}

/** Kết quả tìm kiếm — chỉ đủ để vẽ một dòng gợi ý. */
export interface ProfileSummary {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface ProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  status_message: string | null;
  bio: string | null;
  location: string | null;
  links: ProfileLink[] | null;
  accent_color: string | null;
  birthdate: string;
  created_at: string;
}

type ProfileSummaryRow = Pick<
  ProfileRow,
  'id' | 'username' | 'display_name' | 'avatar_url'
>;

const PROFILE_COLUMNS =
  'id, username, display_name, avatar_url, banner_url, status_message, bio, location, links, accent_color, birthdate, created_at';

const SUMMARY_COLUMNS = 'id, username, display_name, avatar_url';

/** Mã lỗi Postgres cho vi phạm CHECK constraint. */
const CHECK_VIOLATION = '23514';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly media: MediaService,
  ) {}

  /** Hồ sơ của chính người đang đăng nhập. */
  async getOwn(userId: string): Promise<OwnProfile> {
    const row = await this.findById(userId);
    return this.toOwnProfile(row);
  }

  /**
   * Hồ sơ của một người bất kỳ theo username.
   *
   * Mọi người đã đăng nhập đều xem được — hồ sơ là công khai trong ứng dụng.
   * `viewerId` chỉ để đánh dấu `isSelf`, không dùng để phân quyền đọc.
   */
  async getByUsername(
    username: string,
    viewerId: string,
  ): Promise<PublicProfile> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('username', username.trim().toLowerCase())
      .maybeSingle<ProfileRow>();

    if (error) {
      this.logger.error(`Đọc hồ sơ ${username} thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không đọc được hồ sơ. Vui lòng thử lại.',
      );
    }
    if (!data) {
      throw new NotFoundException('Không tìm thấy người dùng này.');
    }

    return this.toPublicProfile(data, viewerId);
  }

  /**
   * Cập nhật hồ sơ. Trường không có trong DTO thì giữ nguyên, trường mang giá trị
   * `null` thì bị xoá — xem ghi chú ngữ nghĩa PATCH ở `UpdateProfileDto`.
   */
  async update(userId: string, dto: UpdateProfileDto): Promise<OwnProfile> {
    const patch: Record<string, unknown> = {};

    if (dto.displayName !== undefined) patch.display_name = dto.displayName;
    if (dto.statusMessage !== undefined)
      patch.status_message = dto.statusMessage;
    if (dto.bio !== undefined) patch.bio = dto.bio;
    if (dto.location !== undefined) patch.location = dto.location;
    if (dto.accentColor !== undefined) patch.accent_color = dto.accentColor;
    if (dto.links !== undefined) {
      // Chỉ giữ đúng hai khoá DB chấp nhận — instance DTO có thể mang thêm thứ khác.
      patch.links = dto.links.map(({ label, url }) => ({ label, url }));
    }

    // Không có gì để đổi thì đừng chạm vào bảng: mỗi UPDATE đều đẩy `updated_at`
    // lên, và đó là thông tin sai nếu thực chất chẳng có gì thay đổi.
    if (Object.keys(patch).length === 0) {
      return this.getOwn(userId);
    }

    return this.applyPatch(userId, patch);
  }

  /** Nhận ảnh mới, đẩy lên Storage rồi ghi URL vào hồ sơ. */
  async setImage(
    kind: ProfileImageKind,
    userId: string,
    file: Express.Multer.File,
  ): Promise<OwnProfile> {
    // Đọc trước để người chưa có hồ sơ không làm bẩn bucket bằng ảnh mồ côi.
    await this.findById(userId);

    const url = await this.media.uploadProfileImage(kind, userId, file);
    return this.applyPatch(userId, { [this.columnFor(kind)]: url });
  }

  /**
   * Gỡ ảnh khỏi hồ sơ.
   *
   * Xoá cột trước, xoá file sau: nếu bước xoá file hỏng thì hồ sơ vẫn đúng (không
   * còn ảnh), chỉ còn lại một file rác trong bucket sẽ bị ghi đè ở lần upload sau.
   * Làm ngược lại thì hồ sơ trỏ tới file đã biến mất — ảnh vỡ trên giao diện.
   */
  async removeImage(
    kind: ProfileImageKind,
    userId: string,
  ): Promise<OwnProfile> {
    const profile = await this.applyPatch(userId, {
      [this.columnFor(kind)]: null,
    });
    await this.media.removeProfileImage(kind, userId);
    return profile;
  }

  /**
   * Tìm người theo tiền tố username hoặc tên hiển thị.
   *
   * Từ khoá phải qua hai lớp escape:
   *  1. LIKE — `%` và `_` là ký tự đại diện, mà username lại cho phép `_`; không
   *     escape thì người gõ `a_b` khớp luôn cả `axb`.
   *  2. PostgREST — trong `or=(...)` dấu phẩy tách các điều kiện, nên giá trị phải
   *     bọc trong nháy kép và escape `"` với `\` bên trong. Thiếu bước này, một
   *     tên hiển thị có dấu phẩy sẽ tạo thành điều kiện lạ trong truy vấn.
   */
  async search(query: string, viewerId: string): Promise<ProfileSummary[]> {
    const likeEscaped = query.replace(/[\\%_]/g, '\\$&');
    const term = likeEscaped.replace(/["\\]/g, '\\$&');

    const { data, error } = await this.supabase.client
      .from('profiles')
      .select(SUMMARY_COLUMNS)
      .or(`username.ilike."${term}%",display_name.ilike."%${term}%"`)
      .neq('id', viewerId)
      .order('username')
      .limit(SEARCH_RESULT_LIMIT)
      .returns<ProfileSummaryRow[]>();

    if (error) {
      this.logger.error(`Tìm hồ sơ thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không tìm được. Vui lòng thử lại.',
      );
    }

    return (data ?? []).map((row) => this.toSummary(row));
  }

  private columnFor(kind: ProfileImageKind): 'avatar_url' | 'banner_url' {
    return kind === 'avatar' ? 'avatar_url' : 'banner_url';
  }

  private async findById(userId: string): Promise<ProfileRow> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle<ProfileRow>();

    if (error) {
      this.logger.error(`Đọc hồ sơ ${userId} thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không đọc được hồ sơ. Vui lòng thử lại.',
      );
    }
    if (!data) {
      // Tài khoản đăng nhập Google/SĐT chưa qua bước hoàn tất hồ sơ.
      throw new NotFoundException(
        'Bạn chưa có hồ sơ. Hãy hoàn tất hồ sơ trước.',
      );
    }
    return data;
  }

  private async applyPatch(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<OwnProfile> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .update(patch)
      .eq('id', userId)
      .select(PROFILE_COLUMNS)
      .maybeSingle<ProfileRow>();

    if (error) {
      // DTO đã chặn phần lớn giá trị sai; tới được đây nghĩa là ràng buộc DB chặt
      // hơn DTO — trả 400 để người dùng sửa được, thay vì 500 khó hiểu.
      if (error.code === CHECK_VIOLATION) {
        throw new BadRequestException('Thông tin không hợp lệ.');
      }
      this.logger.error(`Cập nhật hồ sơ ${userId} thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không lưu được hồ sơ. Vui lòng thử lại.',
      );
    }
    if (!data) {
      throw new NotFoundException(
        'Bạn chưa có hồ sơ. Hãy hoàn tất hồ sơ trước.',
      );
    }

    return this.toOwnProfile(data);
  }

  private toPublicProfile(row: ProfileRow, viewerId: string): PublicProfile {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bannerUrl: row.banner_url,
      statusMessage: row.status_message,
      bio: row.bio,
      location: row.location,
      links: row.links ?? [],
      accentColor: row.accent_color,
      createdAt: row.created_at,
      isSelf: row.id === viewerId,
    };
  }

  private toOwnProfile(row: ProfileRow): OwnProfile {
    return { ...this.toPublicProfile(row, row.id), birthdate: row.birthdate };
  }

  private toSummary(row: ProfileSummaryRow): ProfileSummary {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    };
  }
}
