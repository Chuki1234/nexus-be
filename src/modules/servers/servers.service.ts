import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { MediaService } from '../../infra/storage/media.service';
import { Permission } from '../../shared/permissions';
import { Room } from '../../shared/socket-events';
import { ChatGateway } from '../realtime/chat.gateway';
import { ServerPermissionsService } from './server-permissions.service';
import {
  SERVER_TEMPLATES,
  ServerTemplateDefinition,
} from './constants/server-templates.constant';
import { CreateChannelDto } from './dto/create-channel.dto';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import {
  ChannelSummaryDto,
  CreateServerResponseDto,
  ServerWithChannelsDto,
} from './dto/server-response.dto';
import { ServerMemberDto } from '../../shared/dto/server-members.dto';
import { ServerPreviewDto } from '../../shared/dto/server-invitations.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ServerChannelStructureDto,
  ServerChannelStructureRootItemDto,
} from './dto/server-channel-structure.dto';

interface RawServerRow {
  id: string;
  name: string;
  template_id?: string;
  icon_url: string | null;
  created_at?: string;
  channel_structure?: unknown;
  channel_structure_revision?: number;
  channel_structure_updated_at?: string | null;
}

interface RawChannelRow {
  id: string;
  server_id: string;
  name: string;
  type: string;
  topic: string | null;
  position: number;
}

/** `servers.id` là `uuid` — chặn id rác trước khi bắn query xuống Postgres. */
const SERVER_ID_UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly chatGateway: ChatGateway,
    private readonly serverPermissions: ServerPermissionsService,
    private readonly media: MediaService,
  ) {}

  /**
   * Lấy danh sách canonical template cho máy chủ.
   */
  getTemplates(): readonly ServerTemplateDefinition[] {
    return SERVER_TEMPLATES;
  }

  /**
   * Xem trước công khai của một máy chủ theo id — GET /api/servers/:serverId/preview.
   *
   * Dùng cho card "giới thiệu máy chủ" khi dán link `origin/channels/:serverId`
   * vào khung chat. Endpoint để public (giống `getInvitePreview`) nên CHỈ được
   * trả field công khai an toàn: id, tên, icon, banner, số thành viên — tuyệt đối
   * không trả `owner_id` hay dữ liệu nhạy cảm khác.
   *
   * Validate `serverId` là uuid trước khi query (400 nếu sai) để không đẩy chuỗi
   * rác xuống Postgres, và trả 404 rõ ràng khi máy chủ không tồn tại thay vì để
   * lỗi 500 chung chung.
   */
  async getServerPreview(serverId: string): Promise<ServerPreviewDto> {
    const trimmed = serverId?.trim();
    if (!trimmed || !SERVER_ID_UUID_REGEX.test(trimmed)) {
      throw new BadRequestException('Mã máy chủ không hợp lệ.');
    }

    const { data: server, error } = await this.supabase.client
      .from('servers')
      .select('id, name, icon_url, banner_url')
      .eq('id', trimmed)
      .maybeSingle();

    if (error) {
      this.logger.error(`Tra cứu server preview thất bại: ${error.message}`);
      throw new InternalServerErrorException('Lỗi tra cứu thông tin máy chủ.');
    }

    if (!server) {
      throw new NotFoundException('Máy chủ không tồn tại hoặc đã bị xóa.');
    }

    // Đếm thành viên tách riêng (head:true → chỉ lấy count, không kéo hàng) —
    // giống cách getInvitePreview đếm, tránh join làm phồng payload.
    const { count: memberCount } = await this.supabase.client
      .from('server_members')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', trimmed);

    return {
      serverId: server.id,
      name: server.name,
      iconUrl: server.icon_url ?? null,
      bannerUrl: server.banner_url ?? null,
      memberCount: memberCount ?? 1,
    };
  }

  /**
   * Tạo máy chủ mới kèm toàn bộ kênh theo mẫu trong đúng 1 transaction PostgreSQL RPC nguyên tử:
   * - Tạo bản ghi trong `public.servers` kèm `template_id`
   * - Thêm user hiện tại vào `public.server_members` với role `OWNER`
   * - Tạo toàn bộ kênh chữ và kênh thoại được định nghĩa trong mẫu vào `public.channels`
   *
   * Tuyệt đối không dùng chuỗi insert độc lập làm fallback (tránh tình trạng dữ liệu dở dang).
   */
  async createServer(
    userId: string,
    dto: CreateServerDto,
  ): Promise<CreateServerResponseDto> {
    const trimmedName = dto.name.trim();

    const template = SERVER_TEMPLATES.find((t) => t.id === dto.templateId);
    if (!template) {
      throw new BadRequestException('Mẫu máy chủ không hợp lệ.');
    }

    // Gọi hàm RPC PostgreSQL nguyên tử
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'create_server_with_template',
      {
        p_owner_id: userId,
        p_name: trimmedName,
        p_template_id: dto.templateId,
        p_channels: template.channels,
      },
    );

    if (rpcError) {
      this.logger.error(
        `Tạo máy chủ qua RPC create_server_with_template thất bại: ${rpcError.message} (code: ${rpcError.code})`,
      );

      if (rpcError.code === '22023') {
        throw new BadRequestException(rpcError.message);
      }

      if (
        rpcError.code === '42883' ||
        rpcError.code === 'PGRST202' ||
        rpcError.message?.includes('create_server_with_template') ||
        rpcError.message?.includes('schema cache')
      ) {
        throw new ServiceUnavailableException(
          'Cơ sở dữ liệu chưa sẵn sàng: RPC create_server_with_template chưa được tạo trên Supabase (chưa áp dụng migration).',
        );
      }

      if (
        rpcError.code === '42P01' ||
        rpcError.code === 'PGRST204' ||
        rpcError.message?.includes('relation')
      ) {
        throw new ServiceUnavailableException(
          'Cơ sở dữ liệu chưa sẵn sàng: Bảng dữ liệu máy chủ chưa được tạo trên Supabase (chưa áp dụng migration).',
        );
      }

      throw new InternalServerErrorException(
        'Không tạo được máy chủ trên cơ sở dữ liệu. Vui lòng thử lại sau.',
      );
    }

    if (!rpcData) {
      throw new InternalServerErrorException(
        'Không nhận được dữ liệu phản hồi từ máy chủ cơ sở dữ liệu.',
      );
    }

    return rpcData as CreateServerResponseDto;
  }

  /**
   * Lấy danh sách máy chủ mà user đang tham gia, kèm toàn bộ channels theo đúng thứ tự position.
   */
  /**
   * Tính badge chưa đọc/nhắc tên cho một tập kênh theo đúng thiết kế của bảng
   * `read_states` (nguồn DUY NHẤT cho unread) — tính ON-READ nên tự đúng sau khi
   * F5 hoặc mở tab thứ hai, không phụ thuộc bộ đếm trong memory.
   *
   * - `unread` = có tin (không phải của mình, chưa xoá) với id > last_read.
   * - `mention` = số tin thoả điều kiện trên VÀ nhắc `@username`/`@everyone`/`@here`.
   *
   * Tối ưu: 1 query read_states + 1 query ứng viên nhắc tên cho cả cụm kênh, còn
   * kiểm tra tồn tại unread chạy song song (Promise.all).
   */
  private async computeChannelBadges(
    userId: string,
    channelIds: string[],
  ): Promise<Map<string, { unread: boolean; mention: number }>> {
    const result = new Map<string, { unread: boolean; mention: number }>();
    if (channelIds.length === 0) return result;
    for (const id of channelIds) result.set(id, { unread: false, mention: 0 });

    try {
      await this.fillChannelBadges(userId, channelIds, result);
    } catch (err) {
      // Badge chỉ là phụ trợ: lỗi tính toán không được làm hỏng danh sách kênh.
      this.logger.warn(`computeChannelBadges lỗi (badge về 0): ${String(err)}`);
    }
    return result;
  }

  private async fillChannelBadges(
    userId: string,
    channelIds: string[],
    result: Map<string, { unread: boolean; mention: number }>,
  ): Promise<void> {
    // Con trỏ đã đọc theo kênh.
    const { data: reads } = await this.supabase.client
      .from('read_states')
      .select('channel_id, last_read_message_id')
      .eq('user_id', userId)
      .in('channel_id', channelIds);
    const lastReadMap = new Map<string, string | null>();
    for (const r of reads ?? []) {
      lastReadMap.set(
        r.channel_id as string,
        r.last_read_message_id ? String(r.last_read_message_id) : null,
      );
    }

    const gtBigInt = (id: string, threshold: string | null): boolean => {
      if (!threshold) return true;
      try {
        return BigInt(id) > BigInt(threshold);
      } catch {
        return true;
      }
    };

    // Username để dò `@username`.
    const { data: me } = await this.supabase.client
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .maybeSingle();
    const username = (me?.username as string | undefined)?.toLowerCase() ?? '';

    // Ứng viên nhắc tên cho toàn cụm kênh (1 query). Bọc giá trị trong ngoặc kép
    // để `.` trong username không phá cú pháp `.or()` của PostgREST.
    const orParts = ['content.ilike."%@everyone%"', 'content.ilike."%@here%"'];
    if (username) orParts.push(`content.ilike."%@${username}%"`);
    const { data: mentionRows } = await this.supabase.client
      .from('messages')
      .select('channel_id, id')
      .in('channel_id', channelIds)
      .neq('author_id', userId)
      .is('deleted_at', null)
      .or(orParts.join(','));
    for (const m of mentionRows ?? []) {
      const cid = m.channel_id as string;
      const last = lastReadMap.get(cid) ?? null;
      if (gtBigInt(String(m.id), last)) {
        const cur = result.get(cid);
        if (cur) cur.mention += 1;
      }
    }

    // Tồn tại tin chưa đọc theo từng kênh (song song).
    await Promise.all(
      channelIds.map(async (cid) => {
        const last = lastReadMap.get(cid) ?? null;
        let q = this.supabase.client
          .from('messages')
          .select('id')
          .eq('channel_id', cid)
          .neq('author_id', userId)
          .is('deleted_at', null)
          .order('id', { ascending: false })
          .limit(1);
        if (last) q = q.gt('id', last);
        const { data } = await q;
        const cur = result.get(cid);
        if (cur && data && data.length > 0) cur.unread = true;
      }),
    );
  }

  async listUserServers(userId: string): Promise<ServerWithChannelsDto[]> {
    // 1. Lấy danh sách server_id từ server_members
    const { data: memberships, error: memberError } = await this.supabase.client
      .from('server_members')
      .select('server_id')
      .eq('user_id', userId);

    if (memberError) {
      this.logger.error(
        `Lấy danh sách server_members thất bại: ${memberError.message}`,
      );
      throw new InternalServerErrorException(
        'Không tải được danh sách máy chủ.',
      );
    }

    if (!memberships || memberships.length === 0) {
      return [];
    }

    const serverIds = memberships.map(
      (m: { server_id: string }) => m.server_id,
    );

    // 2. Lấy thông tin servers
    const { data: servers, error: serverError } = await this.supabase.client
      .from('servers')
      .select(
        'id, name, template_id, icon_url, created_at, channel_structure, channel_structure_revision, channel_structure_updated_at',
      )
      .in('id', serverIds)
      .order('created_at', { ascending: true });

    if (serverError) {
      this.logger.error(`Lấy servers thất bại: ${serverError.message}`);
      throw new InternalServerErrorException(
        'Không tải được danh sách máy chủ.',
      );
    }

    // 3. Lấy channels thuộc các servers trên theo thứ tự position
    const { data: channels, error: channelError } = await this.supabase.client
      .from('channels')
      .select('id, server_id, name, type, topic, position')
      .in('server_id', serverIds)
      .order('position', { ascending: true });

    if (channelError) {
      this.logger.error(`Lấy channels thất bại: ${channelError.message}`);
      throw new InternalServerErrorException(
        'Không tải được danh sách kênh máy chủ.',
      );
    }

    const rawServers = (servers ?? []) as RawServerRow[];
    const rawChannels = (channels ?? []) as RawChannelRow[];

    // Badge chưa đọc/nhắc tên (persist qua reload) cho toàn bộ kênh text.
    const textChannelIds = rawChannels
      .filter((c) => c.type !== 'voice')
      .map((c) => c.id);
    const badges = await this.computeChannelBadges(userId, textChannelIds);

    return rawServers.map((server) => {
      const serverChannels = rawChannels
        .filter((c) => c.server_id === server.id)
        .map((c) => {
          const b = badges.get(c.id);
          return {
            id: c.id,
            name: c.name,
            type: (c.type === 'voice' ? 'voice' : 'text') as 'text' | 'voice',
            topic: c.topic ?? null,
            position: c.position,
            unread: b?.unread ?? false,
            mentionCount: b?.mention ?? 0,
          };
        });

      const serverUnread = serverChannels.some((c) => c.unread || c.mentionCount > 0);
      const serverMentions = serverChannels.reduce((acc, c) => acc + c.mentionCount, 0);

      return {
        id: server.id,
        name: server.name,
        templateId: server.template_id,
        iconUrl: server.icon_url ?? null,
        unread: serverUnread,
        mentionCount: serverMentions,
        channels: serverChannels,
        channelStructure: this.mapStoredChannelStructure(server),
      };
    });
  }

  /**
   * Lấy danh sách toàn bộ kênh của một máy chủ.
   */
  async listServerChannels(
    userId: string,
    serverId: string,
  ): Promise<ChannelSummaryDto[]> {
    const { data: member, error: memberError } = await this.supabase.client
      .from('server_members')
      .select('server_id')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .maybeSingle();

    if (memberError || !member) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của máy chủ này.',
      );
    }

    const { data: channels, error: channelsError } = await this.supabase.client
      .from('channels')
      .select('id, server_id, name, type, topic, position')
      .eq('server_id', serverId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });

    if (channelsError) {
      this.logger.error(`Lỗi tải danh sách kênh: ${channelsError.message}`);
      throw new InternalServerErrorException('Không thể tải danh sách kênh.');
    }

    // Filter theo VIEW_CHANNEL — chỉ trả kênh mà user có effective VIEW_CHANNEL permission
    // Chống rò rỉ metadata kênh private qua REST API
    const allChannels: RawChannelRow[] = channels || [];
    const visibleChannels: ChannelSummaryDto[] = [];

    for (const c of allChannels) {
      try {
        const perms = await this.serverPermissions.getChannelPermissions(
          userId,
          c.id,
        );
        if ((perms & Permission.VIEW_CHANNEL) !== 0n) {
          visibleChannels.push({
            id: c.id,
            name: c.name,
            type: (c.type === 'voice' ? 'voice' : 'text') as 'text' | 'voice',
            topic: c.topic ?? null,
            position: c.position,
            unread: false,
            mentionCount: 0,
          });
        }
      } catch {
        // Channel permission check failed — skip this channel (safe default: deny)
      }
    }

    // Badge chỉ tính cho các kênh text mà user THỰC SỰ nhìn thấy (đã lọc VIEW_CHANNEL
    // ở trên) — không rò rỉ chưa đọc của kênh riêng tư.
    const badges = await this.computeChannelBadges(
      userId,
      visibleChannels.filter((c) => c.type !== 'voice').map((c) => c.id),
    );
    for (const c of visibleChannels) {
      const b = badges.get(c.id);
      if (b) {
        c.unread = b.unread;
        c.mentionCount = b.mention;
      }
    }

    return visibleChannels;
  }

  /**
   * Lấy cấu trúc category/channel canonical của server cho một thành viên.
   * Null có nghĩa frontend cần derive layout mặc định từ channels.position.
   */
  async getChannelStructure(
    userId: string,
    serverId: string,
  ): Promise<ServerChannelStructureDto | null> {
    const { data: membership, error: membershipError } =
      await this.supabase.client
        .from('server_members')
        .select('server_id')
        .eq('server_id', serverId)
        .eq('user_id', userId)
        .maybeSingle();

    if (membershipError || !membership) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của máy chủ này.',
      );
    }

    const { data: server, error } = await this.supabase.client
      .from('servers')
      .select(
        'channel_structure, channel_structure_revision, channel_structure_updated_at',
      )
      .eq('id', serverId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Lấy cấu trúc kênh server thất bại: ${error.message}`);
      throw new InternalServerErrorException(
        'Không thể tải cấu trúc kênh máy chủ.',
      );
    }
    if (!server) {
      throw new NotFoundException('Máy chủ không tồn tại.');
    }

    return this.mapStoredChannelStructure(server as RawServerRow);
  }

  /**
   * Lưu cấu trúc category/channel dùng chung. Chỉ owner/admin hoặc role có
   * MANAGE_CHANNELS được phép cập nhật; mọi channel của server phải xuất hiện
   * đúng một lần trong layout để không thể làm mất kênh khỏi sidebar.
   */
  async updateChannelStructure(
    userId: string,
    serverId: string,
    input: ServerChannelStructureDto,
  ): Promise<ServerChannelStructureDto> {
    const capabilities = await this.serverPermissions.getCapabilities(
      userId,
      serverId,
    );
    if (!capabilities.canManageChannels) {
      throw new ForbiddenException(
        'Bạn không có quyền thay đổi cấu trúc kênh.',
      );
    }

    const { data: channelRows, error: channelError } =
      await this.supabase.client
        .from('channels')
        .select('id')
        .eq('server_id', serverId);

    if (channelError) {
      this.logger.error(
        `Kiểm tra channel structure thất bại: ${channelError.message}`,
      );
      throw new InternalServerErrorException(
        'Không thể kiểm tra cấu trúc kênh máy chủ.',
      );
    }

    const knownChannelIds = new Set(
      (channelRows ?? []).map((row: { id: string }) => row.id),
    );
    const structure = this.validateAndNormalizeChannelStructure(
      input,
      knownChannelIds,
    );

    const { data: current, error: currentError } = await this.supabase.client
      .from('servers')
      .select('channel_structure_revision')
      .eq('id', serverId)
      .maybeSingle();

    if (currentError || !current) {
      throw new NotFoundException('Máy chủ không tồn tại.');
    }

    const revision = Number(current.channel_structure_revision ?? 0) + 1;
    const updatedAt = new Date().toISOString();
    const { error: updateError } = await this.supabase.client
      .from('servers')
      .update({
        channel_structure: structure,
        channel_structure_revision: revision,
        channel_structure_updated_at: updatedAt,
        channel_structure_updated_by: userId,
      })
      .eq('id', serverId);

    if (updateError) {
      this.logger.error(
        `Lưu cấu trúc kênh server thất bại: ${updateError.message}`,
      );
      if (
        updateError.code === '42703' ||
        updateError.code === 'PGRST204' ||
        updateError.message?.includes('channel_structure')
      ) {
        throw new ServiceUnavailableException(
          'Cơ sở dữ liệu chưa sẵn sàng: migration cấu trúc kênh chưa được áp dụng.',
        );
      }
      throw new InternalServerErrorException(
        'Không thể lưu cấu trúc kênh máy chủ.',
      );
    }

    const result: ServerChannelStructureDto = {
      ...structure,
      revision,
      updatedAt,
    };

    try {
      this.chatGateway.server
        .to(Room.server(serverId))
        .emit('server:channel-structure-updated', {
          serverId,
          structure: result,
          updatedBy: userId,
        });
    } catch (err) {
      this.logger.warn(
        `Phát tán server:channel-structure-updated thất bại: ${err}`,
      );
    }

    return result;
  }

  /**
   * Tạo kênh mới trong một máy chủ qua RPC nguyên tử `create_server_channel`:
   * 1. Xác thực quyền MANAGE_CHANNELS / ADMINISTRATOR / Owner trong RPC transaction (chống TOCTOU).
   * 2. Sử dụng Advisory Lock ổn định `pg_advisory_xact_lock` theo serverId chống xung đột position.
   * 3. Insert vào bảng `public.channels` và phát realtime event tới Server Room.
   */
  async createChannel(
    userId: string,
    serverId: string,
    dto: CreateChannelDto,
  ): Promise<ChannelSummaryDto> {
    const trimmedName = dto.name?.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new BadRequestException('Tên kênh phải từ 1 đến 100 ký tự.');
    }

    if (dto.type !== 'text' && dto.type !== 'voice') {
      throw new BadRequestException(
        'Loại kênh chỉ có thể là "text" hoặc "voice".',
      );
    }

    const trimmedTopic = dto.topic ? dto.topic.trim() : null;

    // Gọi RPC create_server_channel nguyên tử
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'create_server_channel',
      {
        p_server_id: serverId,
        p_user_id: userId,
        p_name: trimmedName,
        p_type: dto.type,
        p_topic: trimmedTopic,
      },
    );

    if (rpcError) {
      this.logger.error(
        `Tạo kênh qua RPC create_server_channel thất bại: ${rpcError.message} (code: ${rpcError.code})`,
      );

      if (rpcError.code === '42501') {
        throw new ForbiddenException(rpcError.message);
      }
      if (rpcError.code === 'P0002') {
        throw new BadRequestException('Máy chủ không tồn tại.');
      }
      if (rpcError.code === '22023') {
        throw new BadRequestException(rpcError.message);
      }
      if (rpcError.code === '23505') {
        throw new ConflictException(
          'Tên kênh đã tồn tại trong máy chủ này (không phân biệt chữ hoa/thường).',
        );
      }
      if (
        rpcError.code === '42883' ||
        rpcError.code === 'PGRST202' ||
        rpcError.message?.includes('create_server_channel') ||
        rpcError.message?.includes('schema cache')
      ) {
        throw new ServiceUnavailableException(
          'Cơ sở dữ liệu chưa sẵn sàng: RPC create_server_channel chưa được áp dụng migration.',
        );
      }

      throw new InternalServerErrorException(
        'Không thể tạo kênh trên máy chủ.',
      );
    }

    const result: ChannelSummaryDto = {
      id: rpcData.id,
      name: rpcData.name,
      type: rpcData.type as 'text' | 'voice',
      topic: rpcData.topic ?? null,
      unread: false,
      mentionCount: 0,
    };

    try {
      this.chatGateway.emitChannelsInvalidated(serverId);
    } catch (err) {
      this.logger.warn(`Phát tán server:channels-invalidated thất bại: ${err}`);
    }

    return result;
  }

  /**
   * Cập nhật thông tin máy chủ (tên, ảnh đại diện/icon)
   * - Chỉ Owner hoặc thành viên có quyền MANAGE_SERVER mới được cập nhật
   * - Cập nhật bảng public.servers
   * - Phát sự kiện server:updated tới Room.server(serverId) để toàn bộ thành viên cập nhật realtime
   */
  async updateServer(
    userId: string,
    serverId: string,
    dto: UpdateServerDto,
  ): Promise<{ id: string; name: string; iconUrl: string | null }> {
    const caps = await this.serverPermissions.getCapabilities(userId, serverId);
    if (!caps.isOwner && !caps.canManageServer) {
      throw new ForbiddenException('Bạn không có quyền chỉnh sửa máy chủ này.');
    }

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (trimmed.length < 2 || trimmed.length > 100) {
        throw new BadRequestException('Tên máy chủ phải từ 2 đến 100 ký tự.');
      }
      updates.name = trimmed;
    }

    if (dto.iconUrl !== undefined) {
      updates.icon_url = dto.iconUrl ? dto.iconUrl.trim() || null : null;
    }

    const { data, error } = await this.supabase.client
      .from('servers')
      .update(updates)
      .eq('id', serverId)
      .select('id, name, icon_url')
      .single();

    if (error || !data) {
      this.logger.error(`Cập nhật máy chủ thất bại: ${error?.message}`);
      throw new InternalServerErrorException('Không thể cập nhật máy chủ.');
    }

    const res = {
      id: data.id,
      name: data.name,
      iconUrl: data.icon_url,
    };

    // Broadcast realtime event to server room
    try {
      this.chatGateway.server
        .to(Room.server(serverId))
        .emit('server:updated', {
          serverId,
          name: res.name,
          iconUrl: res.iconUrl,
        });
    } catch (err) {
      this.logger.warn(`Phát tán server:updated thất bại: ${err}`);
    }

    return res;
  }

  /**
   * Upload icon máy chủ lên Supabase Storage, cập nhật cột icon_url và broadcast.
   */
  async uploadServerIcon(
    userId: string,
    serverId: string,
    file: Express.Multer.File,
  ): Promise<{ id: string; iconUrl: string }> {
    const caps = await this.serverPermissions.getCapabilities(userId, serverId);
    if (!caps.isOwner && !caps.canManageServer) {
      throw new ForbiddenException('Bạn không có quyền chỉnh sửa máy chủ này.');
    }

    const iconUrl = await this.media.uploadServerIcon(serverId, file);

    const { error } = await this.supabase.client
      .from('servers')
      .update({ icon_url: iconUrl, updated_at: new Date().toISOString() })
      .eq('id', serverId);

    if (error) {
      this.logger.error(`Lưu icon_url thất bại (${serverId}): ${error.message}`);
      throw new InternalServerErrorException('Không thể cập nhật icon máy chủ.');
    }

    try {
      this.chatGateway.server
        .to(Room.server(serverId))
        .emit('server:updated', { serverId, name: '', iconUrl });
    } catch (err) {
      this.logger.warn(`Phát tán server:updated (icon) thất bại: ${err}`);
    }

    return { id: serverId, iconUrl };
  }

  /**
   * Xóa máy chủ nguyên tử (Chỉ dành cho Owner) qua RPC delete_server:
   * - Kiểm tra quyền owner (non-owner bị 42501)
   * - Thu thập danh sách thành viên trước khi cascade delete
   * - Sau khi transaction commit thành công, phát server:deleted tới server room và user rooms của từng thành viên
   */
  async deleteServer(
    userId: string,
    serverId: string,
  ): Promise<{ success: boolean; serverId: string }> {
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'delete_server',
      {
        p_server_id: serverId,
        p_user_id: userId,
      },
    );

    if (rpcError) {
      this.logger.error(
        `Xóa máy chủ qua RPC delete_server thất bại: ${rpcError.message} (code: ${rpcError.code})`,
      );

      if (rpcError.code === '42501') {
        throw new ForbiddenException(rpcError.message);
      }
      if (rpcError.code === 'P0002') {
        throw new NotFoundException('Máy chủ không tồn tại.');
      }
      if (rpcError.code === '22023') {
        throw new BadRequestException(rpcError.message);
      }

      throw new InternalServerErrorException('Không thể xóa máy chủ.');
    }

    // Broadcast realtime event sau khi commit DB thành công
    try {
      const memberUserIds: string[] =
        (rpcData?.memberUserIds as string[]) || [];

      // 1. Gửi vào Room của server
      this.chatGateway.server
        .to(Room.server(serverId))
        .emit('server:deleted', { serverId });

      // 2. Gửi vào User Room của từng thành viên
      for (const memberId of memberUserIds) {
        this.chatGateway.server
          .to(Room.user(memberId))
          .emit('server:deleted', { serverId });
      }
    } catch (broadcastErr) {
      this.logger.warn(
        `Phát tán sự kiện server:deleted thất bại: ${broadcastErr}`,
      );
    }

    return {
      success: true,
      serverId,
    };
  }

  /**
   * Rời máy chủ nguyên tử & Idempotent qua RPC leave_server:
   * - Owner không được rời server -> ConflictException (409)
   * - Non-owner xóa sạch membership và member_roles
   * - Phát tán server:member-left
   */
  async leaveServer(
    userId: string,
    serverId: string,
  ): Promise<{ success: boolean; serverId: string; alreadyLeft: boolean }> {
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'leave_server',
      {
        p_server_id: serverId,
        p_user_id: userId,
      },
    );

    if (rpcError) {
      this.logger.error(
        `Rời máy chủ qua RPC leave_server thất bại: ${rpcError.message} (code: ${rpcError.code})`,
      );

      if (rpcError.code === 'P0002') {
        throw new NotFoundException('Máy chủ không tồn tại.');
      }
      if (rpcError.code === '22023') {
        throw new BadRequestException(rpcError.message);
      }

      throw new InternalServerErrorException('Không thể rời máy chủ.');
    }

    if (rpcData && !rpcData.success) {
      if (rpcData.reason === 'owner_cannot_leave') {
        throw new ConflictException(
          rpcData.message ||
            'Chủ sở hữu không thể rời máy chủ. Vui lòng chuyển quyền sở hữu hoặc xóa máy chủ.',
        );
      }
      throw new BadRequestException(
        rpcData.message || 'Không thể rời máy chủ.',
      );
    }

    // Broadcast member-left nếu vừa thực sự rời
    if (!rpcData?.alreadyLeft) {
      try {
        this.chatGateway.emitServerMemberLeft(serverId, userId);
      } catch (broadcastErr) {
        this.logger.warn(
          `Phát tán sự kiện server:member-left thất bại: ${broadcastErr}`,
        );
      }
    }

    return {
      success: true,
      serverId,
      alreadyLeft: rpcData?.alreadyLeft ?? false,
    };
  }

  /**
   * Trục xuất (Kick) thành viên khỏi máy chủ.
   * Yêu cầu caller có quyền KICK_MEMBERS (hoặc là OWNER/ADMIN).
   * Không thể trục xuất Chủ sở hữu máy chủ.
   */
  async kickServerMember(
    operatorUserId: string,
    serverId: string,
    targetUserId: string,
  ): Promise<{ success: boolean; serverId: string; targetUserId: string }> {
    if (!serverId || !targetUserId) {
      throw new BadRequestException('Tham số không hợp lệ.');
    }

    if (operatorUserId === targetUserId) {
      throw new BadRequestException('Không thể tự trục xuất chính mình. Vui lòng dùng tính năng rời máy chủ.');
    }

    // 1. Kiểm tra quyền của operator
    const capabilities = await this.serverPermissions.getCapabilities(operatorUserId, serverId);
    if (!capabilities.canKickMembers) {
      throw new ForbiddenException('Bạn không có quyền trục xuất thành viên khỏi máy chủ này.');
    }

    // 2. Kiểm tra target user không phải là Owner của server
    const { data: server, error: sErr } = await this.supabase.client
      .from('servers')
      .select('owner_id')
      .eq('id', serverId)
      .maybeSingle();

    if (sErr || !server) {
      throw new NotFoundException('Máy chủ không tồn tại.');
    }

    if (server.owner_id === targetUserId) {
      throw new ForbiddenException('Không thể trục xuất chủ sở hữu máy chủ.');
    }

    // 3. Thực hiện xóa membership qua RPC leave_server (đã có advisory lock & xóa member_roles)
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'leave_server',
      {
        p_server_id: serverId,
        p_user_id: targetUserId,
      },
    );

    if (rpcError) {
      this.logger.error(`Kick thành viên thất bại: ${rpcError.message}`);
      throw new InternalServerErrorException('Không thể trục xuất thành viên.');
    }

    // 4. Realtime Broadcast
    try {
      this.chatGateway.emitServerMemberKicked(serverId, targetUserId, operatorUserId);
    } catch (broadcastErr) {
      this.logger.warn(`Phát tán sự kiện server:member-kicked thất bại: ${broadcastErr}`);
    }

    return {
      success: true,
      serverId,
      targetUserId,
    };
  }

  /**
   * Cấm thành viên (Ban) khỏi máy chủ.
   * Yêu cầu caller có quyền BAN_MEMBERS (hoặc OWNER/ADMIN).
   * Không thể cấm Chủ sở hữu máy chủ.
   */
  async banServerMember(
    operatorUserId: string,
    serverId: string,
    targetUserId: string,
    reason?: string,
  ): Promise<{ success: boolean; serverId: string; targetUserId: string; reason?: string }> {
    if (!serverId || !targetUserId) {
      throw new BadRequestException('Tham số không hợp lệ.');
    }

    if (operatorUserId === targetUserId) {
      throw new BadRequestException('Không thể tự cấm chính mình.');
    }

    // 1. Kiểm tra quyền của operator
    const capabilities = await this.serverPermissions.getCapabilities(operatorUserId, serverId);
    if (!capabilities.canBanMembers) {
      throw new ForbiddenException('Bạn không có quyền cấm thành viên khỏi máy chủ này.');
    }

    // 2. Kiểm tra target user không phải Owner
    const { data: server, error: sErr } = await this.supabase.client
      .from('servers')
      .select('owner_id')
      .eq('id', serverId)
      .maybeSingle();

    if (sErr || !server) {
      throw new NotFoundException('Máy chủ không tồn tại.');
    }

    if (server.owner_id === targetUserId) {
      throw new ForbiddenException('Không thể cấm chủ sở hữu máy chủ.');
    }

    // 3. Thực hiện xóa membership qua RPC leave_server
    const { error: rpcError } = await this.supabase.client.rpc('leave_server', {
      p_server_id: serverId,
      p_user_id: targetUserId,
    });

    if (rpcError) {
      this.logger.error(`Ban thành viên thất bại khi xoá membership: ${rpcError.message}`);
      throw new InternalServerErrorException('Không thể cấm thành viên.');
    }

    // 4. Ghi nhận thông tin cấm vào server_bans (nếu có table hoặc store)
    const { error: banErr } = await this.supabase.client.from('server_bans').upsert({
      server_id: serverId,
      user_id: targetUserId,
      reason: reason || null,
      banned_by: operatorUserId,
      created_at: new Date().toISOString(),
    });

    if (banErr && banErr.code !== 'PGRST205') {
      this.logger.error(`Lưu bản ghi server_bans thất bại: ${banErr.message}`);
    }

    // 5. Broadcast realtime WS
    try {
      this.chatGateway.emitServerMemberBanned(serverId, targetUserId, operatorUserId, reason);
    } catch (broadcastErr) {
      this.logger.warn(`Phát tán sự kiện server:member-banned thất bại: ${broadcastErr}`);
    }

    return {
      success: true,
      serverId,
      targetUserId,
      reason,
    };
  }

  /**
   * Danh sách thành viên bị cấm (Banned Users) của máy chủ.
   * Yêu cầu caller có quyền BAN_MEMBERS hoặc là Owner/Admin.
   */
  async listServerBans(
    operatorUserId: string,
    serverId: string,
  ): Promise<Array<{
    id: string;
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    reason: string | null;
    bannedAt: string;
    bannedBy: string;
  }>> {
    const capabilities = await this.serverPermissions.getCapabilities(operatorUserId, serverId);
    if (!capabilities.canBanMembers) {
      throw new ForbiddenException('Bạn không có quyền xem danh sách thành viên bị cấm.');
    }

    const { data: bans, error } = await this.supabase.client
      .from('server_bans')
      .select('server_id, user_id, reason, banned_by, created_at, profiles:user_id(username, display_name, avatar_url)')
      .eq('server_id', serverId)
      .order('created_at', { ascending: false });

    if (error) {
      if (error.code === 'PGRST205') {
        return [];
      }
      this.logger.error(`Lấy danh sách server_bans thất bại: ${error.message}`);
      return [];
    }

    return (bans || []).map((b: any) => ({
      id: `${b.server_id}_${b.user_id}`,
      userId: b.user_id,
      username: b.profiles?.username || 'Unknown',
      displayName: b.profiles?.display_name || b.profiles?.username || 'Thành viên bị cấm',
      avatarUrl: b.profiles?.avatar_url || null,
      reason: b.reason || null,
      bannedAt: b.created_at,
      bannedBy: b.banned_by,
    }));
  }

  /**
   * Bỏ cấm (Unban) thành viên khỏi máy chủ.
   * Yêu cầu caller có quyền BAN_MEMBERS.
   */
  async unbanServerMember(
    operatorUserId: string,
    serverId: string,
    targetUserId: string,
  ): Promise<{ success: boolean; serverId: string; targetUserId: string }> {
    if (!serverId || !targetUserId) {
      throw new BadRequestException('Tham số không hợp lệ.');
    }

    const capabilities = await this.serverPermissions.getCapabilities(operatorUserId, serverId);
    if (!capabilities.canBanMembers) {
      throw new ForbiddenException('Bạn không có quyền gỡ cấm thành viên khỏi máy chủ này.');
    }

    const { error } = await this.supabase.client
      .from('server_bans')
      .delete()
      .match({ server_id: serverId, user_id: targetUserId });

    if (error && error.code !== 'PGRST205') {
      this.logger.error(`Bỏ cấm server_bans thất bại: ${error.message}`);
      throw new InternalServerErrorException('Không thể bỏ cấm thành viên.');
    }

    try {
      this.chatGateway.emitServerMemberUnbanned(serverId, targetUserId);
    } catch (broadcastErr) {
      this.logger.warn(`Phát tán sự kiện server:member-unbanned thất bại: ${broadcastErr}`);
    }

    return {
      success: true,
      serverId,
      targetUserId,
    };
  }

  /**
   * Kiểm tra người dùng có đang bị cấm khỏi máy chủ hay không.
   */
  async checkUserBanned(serverId: string, userId: string): Promise<boolean> {
    const { data: ban, error } = await this.supabase.client
      .from('server_bans')
      .select('user_id')
      .match({ server_id: serverId, user_id: userId })
      .maybeSingle();

    if (error || !ban) {
      return false;
    }
    return true;
  }

  /**
   * Lấy danh sách thành viên thực tế của server (kèm thông tin profile).
   * Yêu cầu caller phải là thành viên của server.
   */
  async getServerMembers(
    userId: string,
    serverId: string,
  ): Promise<ServerMemberDto[]> {
    // 1. Kiểm tra caller là thành viên server
    const { data: myMembership, error: myMemErr } = await this.supabase.client
      .from('server_members')
      .select('role')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .maybeSingle();

    if (myMemErr) {
      this.logger.error(
        `Lỗi kiểm tra quyền xem server members: ${myMemErr.message}`,
      );
      throw new InternalServerErrorException('Lỗi xác thực thành viên.');
    }

    if (!myMembership) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của máy chủ này.',
      );
    }

    // 2. Lấy danh sách server_members
    const { data: members, error: memErr } = await this.supabase.client
      .from('server_members')
      .select('user_id, role, nickname, joined_at')
      .eq('server_id', serverId);

    if (memErr) {
      this.logger.error(
        `Lấy danh sách server_members thất bại: ${memErr.message}`,
      );
      throw new InternalServerErrorException('Lỗi tải danh sách thành viên.');
    }

    if (!members || members.length === 0) {
      return [];
    }

    // 3. Lấy profile cho các member
    const userIds = members.map((m) => m.user_id);
    const { data: profiles, error: profErr } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url, created_at')
      .in('id', userIds);

    if (profErr) {
      this.logger.error(`Lấy profiles thất bại: ${profErr.message}`);
      throw new InternalServerErrorException('Lỗi tải thông tin thành viên.');
    }

    const profileMap = new Map<string, any>(
      (profiles || []).map((p: any) => [p.id, p]),
    );

    // 4. Lấy member_roles
    const { data: memberRolesData } = await this.supabase.client
      .from('member_roles')
      .select('user_id, role_id')
      .eq('server_id', serverId);

    const userRolesMap = new Map<string, string[]>();
    for (const mr of memberRolesData || []) {
      const list = userRolesMap.get(mr.user_id) || [];
      list.push(mr.role_id);
      userRolesMap.set(mr.user_id, list);
    }

    return members.map((m) => {
      const p = profileMap.get(m.user_id);
      const assignedRoles = userRolesMap.get(m.user_id) || [];
      return {
        userId: m.user_id,
        username: p?.username || '',
        displayName: m.nickname || p?.display_name || p?.username || 'User',
        avatarUrl: p?.avatar_url || null,
        nickname: m.nickname || null,
        role: m.role || 'MEMBER',
        roles: assignedRoles,
        joinedAt: m.joined_at,
        nexusJoinedAt: p?.created_at || null,
        joinMethod: m.role === 'OWNER' ? 'Chủ sở hữu' : 'Trực tiếp',
      };
    });
  }

  /**
   * Cập nhật thông tin kênh (tên, topic) qua RPC nguyên tử update_server_channel.
   */
  async updateChannel(
    userId: string,
    serverId: string,
    channelId: string,
    dto: UpdateChannelDto,
  ): Promise<ChannelSummaryDto> {
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'update_server_channel',
      {
        p_server_id: serverId,
        p_channel_id: channelId,
        p_user_id: userId,
        p_name: dto.name || '',
        p_topic: dto.topic ?? null,
      },
    );

    if (rpcError) {
      this.logger.error(
        `Cập nhật kênh qua update_server_channel thất bại: ${rpcError.message} (code: ${rpcError.code})`,
      );

      if (rpcError.code === '23505') {
        throw new ConflictException('Tên kênh đã tồn tại trong máy chủ này.');
      }
      if (rpcError.code === '42501') {
        throw new ForbiddenException(rpcError.message);
      }
      if (rpcError.code === 'P0002') {
        throw new NotFoundException(rpcError.message);
      }
      if (rpcError.code === '22023') {
        throw new BadRequestException(rpcError.message);
      }

      throw new InternalServerErrorException('Lỗi cập nhật kênh.');
    }

    const result: ChannelSummaryDto = {
      id: rpcData.id,
      name: rpcData.name,
      type: rpcData.type,
      topic: rpcData.topic,
      position: rpcData.position,
      unread: false,
      mentionCount: 0,
    };

    // Broadcast tới Room.server(serverId) và Room.channel(channelId)
    try {
      this.chatGateway.emitChannelsInvalidated(serverId);
      this.chatGateway.server
        .to(Room.server(serverId))
        .emit('server:channel-updated', {
          serverId,
          channel: result,
        });
      this.chatGateway.server
        .to(Room.channel(channelId))
        .emit('server:channel-updated', {
          serverId,
          channel: result,
        });
    } catch (err) {
      this.logger.warn(`Phát tán server:channel-updated thất bại: ${err}`);
    }

    return result;
  }

  /**
   * Xóa kênh qua RPC nguyên tử delete_server_channel (chặn xóa text channel cuối cùng).
   */
  async deleteChannel(
    userId: string,
    serverId: string,
    channelId: string,
  ): Promise<{ success: boolean; channelId: string; serverId: string }> {
    const { data: rpcData, error: rpcError } = await this.supabase.client.rpc(
      'delete_server_channel',
      {
        p_server_id: serverId,
        p_channel_id: channelId,
        p_user_id: userId,
      },
    );

    if (rpcError) {
      this.logger.error(
        `Xóa kênh qua delete_server_channel thất bại: ${rpcError.message} (code: ${rpcError.code})`,
      );

      if (rpcError.code === '42501') {
        throw new ForbiddenException(rpcError.message);
      }
      if (rpcError.code === 'P0002') {
        throw new NotFoundException(rpcError.message);
      }
      if (rpcError.code === '22023') {
        throw new BadRequestException(rpcError.message);
      }

      throw new InternalServerErrorException('Lỗi xóa kênh.');
    }

    // Broadcast tới Room.server(serverId) và Room.channel(channelId)
    try {
      this.chatGateway.emitChannelsInvalidated(serverId);
      this.chatGateway.server
        .to(Room.server(serverId))
        .emit('server:channel-deleted', {
          serverId,
          channelId,
        });
      this.chatGateway.server
        .to(Room.channel(channelId))
        .emit('server:channel-deleted', {
          serverId,
          channelId,
        });
    } catch (err) {
      this.logger.warn(`Phát tán server:channel-deleted thất bại: ${err}`);
    }

    return {
      success: true,
      channelId,
      serverId,
    };
  }

  private mapStoredChannelStructure(
    server: RawServerRow,
  ): ServerChannelStructureDto | null {
    const stored = server.channel_structure;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return null;
    }

    const structure = stored as ServerChannelStructureDto;
    return {
      ...structure,
      revision: Number(server.channel_structure_revision ?? 0),
      updatedAt: server.channel_structure_updated_at ?? null,
    };
  }

  private validateAndNormalizeChannelStructure(
    input: ServerChannelStructureDto,
    knownChannelIds: Set<string>,
  ): Omit<ServerChannelStructureDto, 'revision' | 'updatedAt'> {
    if (!input || input.version !== 1) {
      throw new BadRequestException('Phiên bản cấu trúc kênh không hợp lệ.');
    }
    if (!Array.isArray(input.categories) || input.categories.length > 100) {
      throw new BadRequestException('Danh sách danh mục không hợp lệ.');
    }
    if (
      !Array.isArray(input.rootItems) ||
      !input.categoryChannels ||
      typeof input.categoryChannels !== 'object' ||
      Array.isArray(input.categoryChannels)
    ) {
      throw new BadRequestException('Bố cục kênh không hợp lệ.');
    }

    const categoryIds = new Set<string>();
    const categories = input.categories.map((category) => {
      const id = typeof category?.id === 'string' ? category.id.trim() : '';
      const name =
        typeof category?.name === 'string' ? category.name.trim() : '';
      if (!id || id.length > 120 || categoryIds.has(id)) {
        throw new BadRequestException(
          'ID danh mục bị trùng hoặc không hợp lệ.',
        );
      }
      if (!name || name.length > 100) {
        throw new BadRequestException('Tên danh mục phải từ 1 đến 100 ký tự.');
      }
      categoryIds.add(id);
      return { id, name, isPrivate: category.isPrivate === true };
    });

    const seenRootIds = new Set<string>();
    const rootCategoryIds = new Set<string>();
    const seenChannelIds = new Set<string>();
    const rootItems: ServerChannelStructureRootItemDto[] = input.rootItems.map(
      (item) => {
        if (
          !item ||
          (item.kind !== 'category' && item.kind !== 'channel') ||
          typeof item.id !== 'string' ||
          !item.id.trim() ||
          seenRootIds.has(item.id)
        ) {
          throw new BadRequestException(
            'Phần tử cấp gốc của cấu trúc kênh không hợp lệ.',
          );
        }
        seenRootIds.add(item.id);

        if (item.kind === 'category') {
          if (!categoryIds.has(item.id) || rootCategoryIds.has(item.id)) {
            throw new BadRequestException(
              'Danh mục cấp gốc không tồn tại hoặc bị trùng.',
            );
          }
          rootCategoryIds.add(item.id);
        } else {
          if (!knownChannelIds.has(item.id) || seenChannelIds.has(item.id)) {
            throw new BadRequestException(
              'Kênh cấp gốc không tồn tại hoặc bị trùng.',
            );
          }
          seenChannelIds.add(item.id);
        }

        return {
          kind: item.kind,
          id: item.id,
        } as ServerChannelStructureRootItemDto;
      },
    );

    if (rootCategoryIds.size !== categoryIds.size) {
      throw new BadRequestException(
        'Mỗi danh mục phải xuất hiện đúng một lần ở cấp gốc.',
      );
    }

    const categoryChannels: Record<string, string[]> = {};
    for (const key of Object.keys(input.categoryChannels)) {
      if (!categoryIds.has(key)) {
        throw new BadRequestException('Cấu trúc chứa danh mục không tồn tại.');
      }
    }
    for (const categoryId of categoryIds) {
      const channelIds = input.categoryChannels[categoryId];
      if (!Array.isArray(channelIds)) {
        throw new BadRequestException(
          'Danh sách kênh con của danh mục không hợp lệ.',
        );
      }
      categoryChannels[categoryId] = channelIds.map((channelId) => {
        if (
          typeof channelId !== 'string' ||
          !knownChannelIds.has(channelId) ||
          seenChannelIds.has(channelId)
        ) {
          throw new BadRequestException(
            'Kênh con không tồn tại hoặc xuất hiện nhiều lần.',
          );
        }
        seenChannelIds.add(channelId);
        return channelId;
      });
    }

    if (seenChannelIds.size !== knownChannelIds.size) {
      throw new BadRequestException(
        'Mọi kênh của máy chủ phải xuất hiện đúng một lần.',
      );
    }

    return { version: 1, categories, rootItems, categoryChannels };
  }
}
