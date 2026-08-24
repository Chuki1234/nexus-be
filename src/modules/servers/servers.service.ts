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
import { Room } from '../../shared/socket-events';
import { ChatGateway } from '../realtime/chat.gateway';
import {
  SERVER_TEMPLATES,
  ServerTemplateDefinition,
} from './constants/server-templates.constant';
import { CreateChannelDto } from './dto/create-channel.dto';
import { CreateServerDto } from './dto/create-server.dto';
import {
  ChannelSummaryDto,
  CreateServerResponseDto,
  ServerWithChannelsDto,
} from './dto/server-response.dto';
import { ServerMemberDto } from '../../shared/dto/server-members.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';

interface RawServerRow {
  id: string;
  name: string;
  template_id?: string;
  icon_url: string | null;
  created_at?: string;
}

interface RawChannelRow {
  id: string;
  server_id: string;
  name: string;
  type: string;
  topic: string | null;
  position: number;
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly chatGateway: ChatGateway,
  ) {}

  /**
   * Lấy danh sách canonical template cho máy chủ.
   */
  getTemplates(): readonly ServerTemplateDefinition[] {
    return SERVER_TEMPLATES;
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
  async listUserServers(userId: string): Promise<ServerWithChannelsDto[]> {
    // 1. Lấy danh sách server_id từ server_members
    const { data: memberships, error: memberError } =
      await this.supabase.client
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
      .select('id, name, template_id, icon_url, created_at')
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

    return rawServers.map((server) => {
      const serverChannels = rawChannels
        .filter((c) => c.server_id === server.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: (c.type === 'voice' ? 'voice' : 'text') as 'text' | 'voice',
          topic: c.topic ?? null,
          unread: false,
          mentionCount: 0,
        }));

      return {
        id: server.id,
        name: server.name,
        templateId: server.template_id,
        iconUrl: server.icon_url ?? null,
        unread: false,
        mentionCount: 0,
        channels: serverChannels,
      };
    });
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
      throw new BadRequestException('Loại kênh chỉ có thể là "text" hoặc "voice".');
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

      throw new InternalServerErrorException('Không thể tạo kênh trên máy chủ.');
    }

    const result: ChannelSummaryDto = {
      id: rpcData.id,
      name: rpcData.name,
      type: rpcData.type as 'text' | 'voice',
      topic: rpcData.topic ?? null,
      unread: false,
      mentionCount: 0,
    };

    return result;
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
      const memberUserIds: string[] = (rpcData?.memberUserIds as string[]) || [];

      // 1. Gửi vào Room của server
      this.chatGateway.server.to(Room.server(serverId)).emit('server:deleted', { serverId });

      // 2. Gửi vào User Room của từng thành viên
      for (const memberId of memberUserIds) {
        this.chatGateway.server.to(Room.user(memberId)).emit('server:deleted', { serverId });
      }
    } catch (broadcastErr) {
      this.logger.warn(`Phát tán sự kiện server:deleted thất bại: ${broadcastErr}`);
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
          rpcData.message || 'Chủ sở hữu không thể rời máy chủ. Vui lòng chuyển quyền sở hữu hoặc xóa máy chủ.',
        );
      }
      throw new BadRequestException(rpcData.message || 'Không thể rời máy chủ.');
    }

    // Broadcast member-left nếu vừa thực sự rời
    if (!rpcData?.alreadyLeft) {
      try {
        // Broadcast tới server room
        this.chatGateway.server.to(Room.server(serverId)).emit('server:member-left', {
          serverId,
          userId,
        });
        // Broadcast tới user room của chính người rời để đồng bộ tất cả các phiên / tab đang mở
        this.chatGateway.server.to(Room.user(userId)).emit('server:member-left', {
          serverId,
          userId,
        });
      } catch (broadcastErr) {
        this.logger.warn(`Phát tán sự kiện server:member-left thất bại: ${broadcastErr}`);
      }
    }

    return {
      success: true,
      serverId,
      alreadyLeft: rpcData?.alreadyLeft ?? false,
    };
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
      this.logger.error(`Lỗi kiểm tra quyền xem server members: ${myMemErr.message}`);
      throw new InternalServerErrorException('Lỗi xác thực thành viên.');
    }

    if (!myMembership) {
      throw new ForbiddenException('Bạn không phải là thành viên của máy chủ này.');
    }

    // 2. Lấy danh sách server_members
    const { data: members, error: memErr } = await this.supabase.client
      .from('server_members')
      .select('user_id, role, nickname, joined_at')
      .eq('server_id', serverId);

    if (memErr) {
      this.logger.error(`Lấy danh sách server_members thất bại: ${memErr.message}`);
      throw new InternalServerErrorException('Lỗi tải danh sách thành viên.');
    }

    if (!members || members.length === 0) {
      return [];
    }

    // 3. Lấy profile cho các member
    const userIds = members.map((m) => m.user_id);
    const { data: profiles, error: profErr } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);

    if (profErr) {
      this.logger.error(`Lấy profiles thất bại: ${profErr.message}`);
      throw new InternalServerErrorException('Lỗi tải thông tin thành viên.');
    }

    const profileMap = new Map<string, any>(
      (profiles || []).map((p: any) => [p.id, p]),
    );

    return members.map((m) => {
      const p = profileMap.get(m.user_id);
      return {
        userId: m.user_id,
        username: p?.username || '',
        displayName: p?.display_name || p?.username || 'User',
        avatarUrl: p?.avatar_url || null,
        nickname: m.nickname || null,
        role: m.role || 'MEMBER',
        joinedAt: m.joined_at,
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
      this.chatGateway.server.to(Room.server(serverId)).emit('server:channel-updated', {
        serverId,
        channel: result,
      });
      this.chatGateway.server.to(Room.channel(channelId)).emit('server:channel-updated', {
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
      this.chatGateway.server.to(Room.server(serverId)).emit('server:channel-deleted', {
        serverId,
        channelId,
      });
      this.chatGateway.server.to(Room.channel(channelId)).emit('server:channel-deleted', {
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
}


