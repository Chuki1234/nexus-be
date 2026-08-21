import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ServerTemplateDefinition } from './constants/server-templates.constant';
import { CreateChannelDto } from './dto/create-channel.dto';
import { CreateServerDto } from './dto/create-server.dto';
import {
  ChannelSummaryDto,
  CreateServerResponseDto,
  ServerWithChannelsDto,
} from './dto/server-response.dto';
import { ServersService } from './servers.service';


@Controller('servers')
@UseGuards(SupabaseAuthGuard)
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  /**
   * GET /api/servers/templates
   *
   * Lấy danh sách canonical template cho máy chủ.
   */
  @Get('templates')
  @HttpCode(HttpStatus.OK)
  getTemplates(): readonly ServerTemplateDefinition[] {
    return this.servers.getTemplates();
  }

  /**
   * POST /api/servers
   *
   * Tạo máy chủ mới và toàn bộ kênh của template theo transaction nguyên tử.
   * `owner_id` được trích xuất an toàn từ `SupabaseAuthGuard` / `@CurrentUser()`.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createServer(
    @CurrentUser() user: User,
    @Body() dto: CreateServerDto,
  ): Promise<CreateServerResponseDto> {
    return this.servers.createServer(user.id, dto);
  }

  /**
   * GET /api/servers
   *
   * Lấy danh sách máy chủ mà user đang là thành viên kèm danh sách kênh.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  listServers(@CurrentUser() user: User): Promise<ServerWithChannelsDto[]> {
    return this.servers.listUserServers(user.id);
  }

  /**
   * POST /api/servers/:serverId/channels
   *
   * Tạo kênh mới (chữ hoặc thoại) trong máy chủ.
   */
  @Post(':serverId/channels')
  @HttpCode(HttpStatus.CREATED)
  createChannel(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: CreateChannelDto,
  ): Promise<ChannelSummaryDto> {
    return this.servers.createChannel(user.id, serverId, dto);
  }
}


/**
 * Controller bổ sung để hỗ trợ trực tiếp endpoint GET /api/server-templates.
 */
@Controller('server-templates')
@UseGuards(SupabaseAuthGuard)
export class ServerTemplatesController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  getTemplates(): readonly ServerTemplateDefinition[] {
    return this.servers.getTemplates();
  }
}
