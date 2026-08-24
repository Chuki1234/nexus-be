import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentServerCapabilities } from '../../shared/dto/server-capabilities.dto';
import { ServerMemberDto } from '../../shared/dto/server-members.dto';
import {
  DirectServerInvitationDto,
  ServerInviteCandidateDto,
  ServerInviteLinkResponseDto,
  ServerInvitePreviewDto,
} from '../../shared/dto/server-invitations.dto';
import { ServerTemplateDefinition } from './constants/server-templates.constant';
import { CreateChannelDto } from './dto/create-channel.dto';
import { CreateDirectInvitationDto, CreateInviteLinkDto } from './dto/create-invite.dto';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ChannelSummaryDto,
  CreateServerResponseDto,
  ServerWithChannelsDto,
} from './dto/server-response.dto';
import { ServerInvitesService } from './server-invites.service';
import { ServerPermissionsService } from './server-permissions.service';
import { ServersService } from './servers.service';

@Controller('servers')
@UseGuards(SupabaseAuthGuard)
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly permissions: ServerPermissionsService,
    private readonly invites: ServerInvitesService,
  ) {}

  /**
   * GET /api/servers/templates
   */
  @Get('templates')
  @HttpCode(HttpStatus.OK)
  getTemplates(): readonly ServerTemplateDefinition[] {
    return this.servers.getTemplates();
  }

  /**
   * POST /api/servers
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
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  listServers(@CurrentUser() user: User): Promise<ServerWithChannelsDto[]> {
    return this.servers.listUserServers(user.id);
  }

  /**
   * GET /api/servers/:serverId/capabilities
   */
  @Get(':serverId/capabilities')
  @HttpCode(HttpStatus.OK)
  getCapabilities(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<CurrentServerCapabilities> {
    return this.permissions.getCapabilities(user.id, serverId);
  }

  /**
   * POST /api/servers/:serverId/channels
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

  /**
   * GET /api/servers/:serverId/invite-candidates
   */
  @Get(':serverId/invite-candidates')
  @HttpCode(HttpStatus.OK)
  getInviteCandidates(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<ServerInviteCandidateDto[]> {
    return this.invites.getInviteCandidates(user.id, serverId);
  }

  /**
   * POST /api/servers/:serverId/invitations
   */
  @Post(':serverId/invitations')
  @HttpCode(HttpStatus.CREATED)
  createDirectInvitation(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: CreateDirectInvitationDto,
  ): Promise<DirectServerInvitationDto> {
    return this.invites.createDirectInvitation(user.id, serverId, dto.inviteeId);
  }

  /**
   * DELETE /api/servers/:serverId/invitations/:id
   */
  @Delete(':serverId/invitations/:id')
  @HttpCode(HttpStatus.OK)
  revokeDirectInvitation(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('id') id: string,
  ): Promise<{ success: boolean }> {
    return this.invites.revokeDirectInvitation(user.id, serverId, id);
  }

  /**
   * POST /api/servers/:serverId/invites
   */
  @Post(':serverId/invites')
  @HttpCode(HttpStatus.CREATED)
  createInviteLink(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: CreateInviteLinkDto,
  ): Promise<ServerInviteLinkResponseDto> {
    return this.invites.createInviteLink(user.id, serverId, dto);
  }

  /**
   * DELETE /api/servers/:serverId/invites/:code
   */
  @Delete(':serverId/invites/:code')
  @HttpCode(HttpStatus.OK)
  revokeInviteLink(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('code') code: string,
  ): Promise<{ success: boolean }> {
    return this.invites.revokeInviteLink(user.id, serverId, code);
  }

  /**
   * GET /api/servers/:serverId/members
   * Lấy danh sách thành viên thực tế trong server.
   */
  @Get(':serverId/members')
  @HttpCode(HttpStatus.OK)
  getServerMembers(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<ServerMemberDto[]> {
    return this.servers.getServerMembers(user.id, serverId);
  }

  /**
   * PATCH /api/servers/:serverId/channels/:channelId
   * Cập nhật thông tin kênh (tên, topic).
   */
  @Patch(':serverId/channels/:channelId')
  @HttpCode(HttpStatus.OK)
  updateChannel(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('channelId') channelId: string,
    @Body() dto: UpdateChannelDto,
  ): Promise<ChannelSummaryDto> {
    return this.servers.updateChannel(user.id, serverId, channelId, dto);
  }

  /**
   * DELETE /api/servers/:serverId/channels/:channelId
   * Xóa kênh trong máy chủ.
   */
  @Delete(':serverId/channels/:channelId')
  @HttpCode(HttpStatus.OK)
  deleteChannel(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('channelId') channelId: string,
  ): Promise<{ success: boolean; channelId: string; serverId: string }> {
    return this.servers.deleteChannel(user.id, serverId, channelId);
  }

  /**
   * DELETE /api/servers/:serverId
   * Xóa máy chủ (Chỉ dành cho Owner)
   */
  @Delete(':serverId')
  @HttpCode(HttpStatus.OK)
  deleteServer(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<{ success: boolean; serverId: string }> {
    return this.servers.deleteServer(user.id, serverId);
  }

  /**
   * DELETE /api/servers/:serverId/members/@me
   * Rời khỏi máy chủ (Chỉ dành cho Non-Owner Member)
   */
  @Delete(':serverId/members/@me')
  @HttpCode(HttpStatus.OK)
  leaveServer(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<{ success: boolean; serverId: string; alreadyLeft: boolean }> {
    return this.servers.leaveServer(user.id, serverId);
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

/**
 * Controller quản lý lời mời trực tiếp của người dùng.
 */
@Controller('server-invitations')
@UseGuards(SupabaseAuthGuard)
export class ServerInvitationsController {
  constructor(private readonly invites: ServerInvitesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  listPendingInvitations(
    @CurrentUser() user: User,
  ): Promise<DirectServerInvitationDto[]> {
    return this.invites.listPendingInvitations(user.id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  acceptInvitation(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ success: boolean; serverId: string; alreadyMember: boolean }> {
    return this.invites.acceptInvitation(user.id, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  declineInvitation(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ success: boolean }> {
    return this.invites.declineInvitation(user.id, id);
  }
}

/**
 * Controller công khai và tham gia link mời.
 */
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: ServerInvitesService) {}

  @Get(':code')
  @HttpCode(HttpStatus.OK)
  getInvitePreview(@Param('code') code: string): Promise<ServerInvitePreviewDto> {
    return this.invites.getInvitePreview(code);
  }

  @Post(':code/join')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  joinByInviteCode(
    @CurrentUser() user: User,
    @Param('code') code: string,
  ): Promise<{ success: boolean; serverId: string; channelId?: string; alreadyMember: boolean }> {
    return this.invites.joinByInviteCode(user.id, code);
  }
}
