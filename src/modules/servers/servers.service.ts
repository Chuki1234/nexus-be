import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import {
  SERVER_TEMPLATES,
  ServerTemplateDefinition,
} from './constants/server-templates.constant';
import { CreateServerDto } from './dto/create-server.dto';
import {
  CreateServerResponseDto,
  ServerWithChannelsDto,
} from './dto/server-response.dto';

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

  constructor(private readonly supabase: SupabaseService) {}

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
}
