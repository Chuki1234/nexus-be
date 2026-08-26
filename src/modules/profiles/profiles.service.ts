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
import { FriendsService } from '../friends/friends.service';
import { SEARCH_RESULT_LIMIT } from './dto/search-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

// Hình dạng dữ liệu trả ra lấy từ `src/shared/` — thư mục được nhân bản y hệt
// sang nexus-fe (`npm run check:shared` canh cho không lệch). Khai báo lại ở
// đây thì frontend sẽ chép tay một bản khác và hai bên trôi khỏi nhau, đúng
// thứ mà `shared/` sinh ra để ngăn.
export type {
  MutualServer,
  OwnProfile,
  ProfileGame,
  ProfileGameKind,
  ProfileLink,
  ProfileSummary,
  PublicProfile,
} from '../../shared';

import type {
  MutualServer,
  OwnProfile,
  ProfileGame,
  ProfileGameKind,
  ProfileLink,
  ProfileSummary,
  PublicProfile,
} from '../../shared';
import { GAME_KIND_LABELS, gameLimitFor } from '../../shared';

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

/**
 * Trò chơi trên hồ sơ KHÔNG nằm trong bảng `profiles` — bảng dùng chung cả
 * team, member không tự thêm cột được (xem `plans/profile.PLAN.md`). Thay vào
 * đó mỗi người có một file JSON riêng trong bucket này (`<userId>.json`),
 * đọc/ghi bằng chính service_role key đang có sẵn, không cần quyền DDL.
 */
const GAMES_BUCKET = 'profile-games';

/**
 * Ghi chú riêng: người XEM tự viết về chủ hồ sơ, chỉ người viết thấy được —
 * khác `games`, đây không phải dữ liệu CỦA hồ sơ nên không nằm trong
 * `PublicProfile`/`OwnProfile`. Khoá theo cặp (viewer, target) nên vẫn dùng
 * Storage như `GAMES_BUCKET`, chỉ khác đường dẫn có thêm một cấp thư mục.
 */
const NOTES_BUCKET = 'profile-notes';

interface ServerMemberRow {
  server_id: string;
  user_id: string;
}

interface ServerRow {
  id: string;
  name: string;
  icon_url: string | null;
}

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly media: MediaService,
    private readonly friends: FriendsService,
  ) {}

  /** Hồ sơ của chính người đang đăng nhập. */
  async getOwn(userId: string): Promise<OwnProfile> {
    const row = await this.findById(userId);
    return this.toOwnProfile(row, await this.loadGames(userId));
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

    const isSelf = data.id === viewerId;
    // Bạn chung/máy chủ chung với CHÍNH MÌNH vô nghĩa — bỏ qua hẳn hai truy
    // vấn đó khi tự xem hồ sơ mình, đỡ tốn round-trip không ai cần tới.
    const [games, mutualFriends, mutualServers] = await Promise.all([
      this.loadGames(data.id),
      isSelf ? Promise.resolve([]) : this.mutualFriends(viewerId, data.id),
      isSelf ? Promise.resolve([]) : this.mutualServers(viewerId, data.id),
    ]);

    return this.toPublicProfile(data, viewerId, games, mutualFriends, mutualServers);
  }

  /** GET /api/profiles/:username/note — ghi chú CỦA NGƯỜI XEM về người này. */
  async getNote(username: string, viewerId: string): Promise<{ text: string }> {
    const targetId = await this.idForUsername(username);
    return { text: await this.loadNote(viewerId, targetId) };
  }

  /** PUT /api/profiles/:username/note — lưu ghi chú, chuỗi rỗng = xoá. */
  async setNote(
    username: string,
    viewerId: string,
    text: string,
  ): Promise<{ text: string }> {
    const targetId = await this.idForUsername(username);
    const trimmed = text.trim();
    await this.saveNote(viewerId, targetId, trimmed);
    return { text: trimmed };
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

    // `games` không phải cột trong bảng `profiles` — xem `GAMES_BUCKET`. Lưu
    // riêng ở đây (nếu có) để không lẫn vào `patch` gửi xuống Postgres.
    let games: ProfileGame[] | undefined;
    if (dto.games !== undefined) {
      this.assertGamesFit(dto.games);
      // Không có CHECK dưới database chặn khoá thừa trong object nữa (không
      // còn constraint SQL), nên càng phải tự cắt ở đây — gán thẳng `dto.games`
      // là mở đường cho client nhét thêm field lạ vào file JSON.
      games = dto.games.map(({ id, kind, title, cover, tags }) => ({
        id,
        kind,
        title,
        cover: cover ?? null,
        tags: tags ?? [],
      }));
      await this.saveGames(userId, games);
    }

    // Không có gì để đổi ở bảng thì đừng chạm vào bảng: mỗi UPDATE đều đẩy
    // `updated_at` lên, và đó là thông tin sai nếu thực chất chẳng có gì thay đổi.
    const row =
      Object.keys(patch).length === 0
        ? await this.findById(userId)
        : await this.applyPatch(userId, patch);

    return this.toOwnProfile(row, games ?? (await this.loadGames(userId)));
  }

  /**
   * PUT /api/profiles/me/birthdate — đổi ngày sinh, tách khỏi `update()` vì
   * đây là dữ liệu kiểm tra tuổi chứ không phải thông tin trang trí hồ sơ (xem
   * ghi chú ở `UpdateProfileDto`). `SetBirthdateDto` đã tự chặn tuổi < 13 rồi
   * nên ở đây chỉ còn việc ghi cột.
   */
  async setBirthdate(userId: string, birthdate: string): Promise<OwnProfile> {
    const row = await this.applyPatch(userId, { birthdate });
    return this.toOwnProfile(row, await this.loadGames(userId));
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
    const row = await this.applyPatch(userId, { [this.columnFor(kind)]: url });
    return this.toOwnProfile(row, await this.loadGames(userId));
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
    const row = await this.applyPatch(userId, {
      [this.columnFor(kind)]: null,
    });
    await this.media.removeProfileImage(kind, userId);
    return this.toOwnProfile(row, await this.loadGames(userId));
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

  /**
   * Chưa từng lưu trò chơi nào thì Storage trả lỗi "không thấy file" — đây là
   * trạng thái bình thường (hồ sơ mới), không log ồn, chỉ lặng lẽ coi như rỗng.
   */
  private async loadGames(userId: string): Promise<ProfileGame[]> {
    const { data, error } = await this.supabase.client.storage
      .from(GAMES_BUCKET)
      .download(`${userId}.json`);
    if (error) {
      return [];
    }

    try {
      return JSON.parse(await data.text()) as ProfileGame[];
    } catch {
      this.logger.warn(`File trò chơi của ${userId} không đọc ra JSON, coi như rỗng.`);
      return [];
    }
  }

  private async saveGames(userId: string, games: ProfileGame[]): Promise<void> {
    const { error } = await this.supabase.client.storage
      .from(GAMES_BUCKET)
      .upload(`${userId}.json`, JSON.stringify(games), {
        contentType: 'application/json',
        upsert: true,
      });

    if (error) {
      this.logger.error(`Lưu trò chơi của ${userId} thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không lưu được trò chơi. Vui lòng thử lại.',
      );
    }
  }

  private async idForUsername(username: string): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('id')
      .eq('username', username.trim().toLowerCase())
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`Tìm id theo username ${username} thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không đọc được hồ sơ. Vui lòng thử lại.',
      );
    }
    if (!data) {
      throw new NotFoundException('Không tìm thấy người dùng này.');
    }
    return data.id;
  }

  /** Chưa từng ghi chú thì Storage trả lỗi "không thấy file" — coi như rỗng. */
  private async loadNote(viewerId: string, targetId: string): Promise<string> {
    const { data, error } = await this.supabase.client.storage
      .from(NOTES_BUCKET)
      .download(`${viewerId}/${targetId}.json`);
    if (error) {
      return '';
    }

    try {
      const parsed = JSON.parse(await data.text()) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      return '';
    }
  }

  private async saveNote(
    viewerId: string,
    targetId: string,
    text: string,
  ): Promise<void> {
    const { error } = await this.supabase.client.storage
      .from(NOTES_BUCKET)
      .upload(`${viewerId}/${targetId}.json`, JSON.stringify({ text }), {
        contentType: 'application/json',
        upsert: true,
      });

    if (error) {
      this.logger.error(
        `Lưu ghi chú ${viewerId} → ${targetId} thất bại: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Không lưu được ghi chú. Vui lòng thử lại.',
      );
    }
  }

  /**
   * Bạn bè của người xem GIAO với bạn bè của chủ hồ sơ.
   *
   * Lỗi ở bước nào cũng chỉ trả rỗng, không ném ra ngoài: đây là khối trang
   * trí trên hồ sơ, không đáng để sập cả trang chỉ vì tính "bạn chung" hỏng.
   */
  private async mutualFriends(
    viewerId: string,
    targetId: string,
  ): Promise<ProfileSummary[]> {
    const [viewerFriendIds, targetFriendIds] = await Promise.all([
      this.friends.getAcceptedFriendUserIds(viewerId),
      this.friends.getAcceptedFriendUserIds(targetId),
    ]);

    const targetSet = new Set(targetFriendIds);
    const mutualIds = viewerFriendIds.filter((id) => targetSet.has(id));
    if (mutualIds.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase.client
      .from('profiles')
      .select(SUMMARY_COLUMNS)
      .in('id', mutualIds)
      .returns<ProfileSummaryRow[]>();

    if (error) {
      this.logger.error(`Tải hồ sơ bạn chung thất bại: ${error.message}`);
      return [];
    }
    return (data ?? []).map((row) => this.toSummary(row));
  }

  /** Máy chủ mà cả người xem lẫn chủ hồ sơ đều là thành viên. */
  private async mutualServers(
    viewerId: string,
    targetId: string,
  ): Promise<MutualServer[]> {
    const { data, error } = await this.supabase.client
      .from('server_members')
      .select('server_id, user_id')
      .in('user_id', [viewerId, targetId])
      .returns<ServerMemberRow[]>();

    if (error) {
      this.logger.error(`Tải máy chủ chung thất bại: ${error.message}`);
      return [];
    }

    const viewerServerIds = new Set(
      (data ?? [])
        .filter((row) => row.user_id === viewerId)
        .map((row) => row.server_id),
    );
    const mutualIds = [
      ...new Set(
        (data ?? [])
          .filter(
            (row) => row.user_id === targetId && viewerServerIds.has(row.server_id),
          )
          .map((row) => row.server_id),
      ),
    ];
    if (mutualIds.length === 0) {
      return [];
    }

    const { data: servers, error: serverError } = await this.supabase.client
      .from('servers')
      .select('id, name, icon_url')
      .in('id', mutualIds)
      .returns<ServerRow[]>();

    if (serverError) {
      this.logger.error(`Tải thông tin máy chủ chung thất bại: ${serverError.message}`);
      return [];
    }
    return (servers ?? []).map((server) => ({
      id: server.id,
      name: server.name,
      iconUrl: server.icon_url,
    }));
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
  ): Promise<ProfileRow> {
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

    return data;
  }

  /**
   * Hạn mức RIÊNG của từng widget, và `id` không được trùng.
   *
   * Không kiểm được bằng decorator: `@ArrayMaxSize` chỉ thấy cả mảng chứ không
   * đếm được theo `kind`. Để rơi xuống CHECK dưới database thì người dùng chỉ
   * nhận mã 23514 → "Thông tin không hợp lệ.", không biết widget nào đầy.
   */
  private assertGamesFit(
    // Nhận đúng ba trường cần dùng thay vì `ProfileGame[]`: instance DTO có
    // `cover?: string | null | undefined` nên không gán thẳng vào được.
    games: ReadonlyArray<Pick<ProfileGame, 'id' | 'kind' | 'title'>>,
  ): void {
    const seen = new Set<string>();
    for (const game of games) {
      if (seen.has(game.id)) {
        throw new BadRequestException(
          `"${game.title}" đã có trong ${GAME_KIND_LABELS[game.kind]}.`,
        );
      }
      seen.add(game.id);
    }

    for (const kind of Object.keys(GAME_KIND_LABELS) as ProfileGameKind[]) {
      const limit = gameLimitFor(kind);
      const count = games.filter((game) => game.kind === kind).length;
      if (count > limit) {
        throw new BadRequestException(
          `Widget "${GAME_KIND_LABELS[kind]}" chỉ chứa được ${limit} trò chơi.`,
        );
      }
    }
  }

  private toPublicProfile(
    row: ProfileRow,
    viewerId: string,
    games: ProfileGame[],
    mutualFriends: ProfileSummary[] = [],
    mutualServers: MutualServer[] = [],
  ): PublicProfile {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bannerUrl: row.banner_url,
      statusMessage: row.status_message,
      bio: row.bio,
      location: row.location,
      birthdate: row.birthdate,
      links: row.links ?? [],
      games,
      mutualFriends,
      mutualServers,
      accentColor: row.accent_color,
      createdAt: row.created_at,
      isSelf: row.id === viewerId,
    };
  }

  /** Luôn tự xem chính mình — "bạn chung với bản thân" vô nghĩa nên bỏ trống. */
  private toOwnProfile(row: ProfileRow, games: ProfileGame[]): OwnProfile {
    return {
      ...this.toPublicProfile(row, row.id, games),
      birthdate: row.birthdate,
    };
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
