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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_UPLOAD_BYTES } from '../../infra/storage/media.service';
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
  ServerPreviewDto,
} from '../../shared/dto/server-invitations.dto';
import { ServerTemplateDefinition } from './constants/server-templates.constant';
import { CreateChannelDto } from './dto/create-channel.dto';
import { CreateServerBanDto } from './dto/create-server-ban.dto';
import {
  CreateDirectInvitationDto,
  CreateInviteLinkDto,
} from './dto/create-invite.dto';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import {
  ServerChannelStructureDto,
  UpdateServerChannelStructureDto,
} from './dto/server-channel-structure.dto';
import {
  ChannelSummaryDto,
  CreateServerResponseDto,
  ServerWithChannelsDto,
} from './dto/server-response.dto';
import { ServerInvitesService } from './server-invites.service';
import { ServerPermissionsService } from './server-permissions.service';
import { ServersService } from './servers.service';
import { ServerRolesService } from './server-roles.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/server-roles.dto';
import type { ServerRoleDto } from './dto/server-roles.dto';

@Controller('servers')
@UseGuards(SupabaseAuthGuard)
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly permissions: ServerPermissionsService,
    private readonly invites: ServerInvitesService,
    private readonly rolesService: ServerRolesService,
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
   * GET /api/servers/:serverId/channels
   */
  @Get(':serverId/channels')
  @HttpCode(HttpStatus.OK)
  listChannels(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<ChannelSummaryDto[]> {
    return this.servers.listServerChannels(user.id, serverId);
  }

  /** GET /api/servers/:serverId/channel-structure */
  @Get(':serverId/channel-structure')
  @HttpCode(HttpStatus.OK)
  getChannelStructure(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<ServerChannelStructureDto | null> {
    return this.servers.getChannelStructure(user.id, serverId);
  }

  /** PUT /api/servers/:serverId/channel-structure */
  @Patch(':serverId/channel-structure')
  @HttpCode(HttpStatus.OK)
  updateChannelStructure(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: UpdateServerChannelStructureDto,
  ): Promise<ServerChannelStructureDto> {
    return this.servers.updateChannelStructure(
      user.id,
      serverId,
      dto.structure,
    );
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
    return this.invites.createDirectInvitation(
      user.id,
      serverId,
      dto.inviteeId,
    );
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
   * PATCH /api/servers/:serverId
   * Cập nhật thông tin máy chủ (tên, avatar icon)
   */
  @Patch(':serverId')
  @HttpCode(HttpStatus.OK)
  updateServer(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: UpdateServerDto,
  ): Promise<{ id: string; name: string; iconUrl: string | null }> {
    return this.servers.updateServer(user.id, serverId, dto);
  }

  /**
   * POST /api/servers/:serverId/icon — multipart, field `file`.
   * Resize → Supabase Storage → cập nhật icon_url → broadcast realtime.
   */
  @Post(':serverId/icon')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  uploadServerIcon(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ id: string; iconUrl: string }> {
    return this.servers.uploadServerIcon(user.id, serverId, file);
  }

  /**
   * DELETE /api/servers/:serverId
   * Xóa máy chủ (Chỉ dành for Owner)
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
   * GET /api/servers/:serverId/roles
   */
  @Get(':serverId/roles')
  getServerRoles(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<ServerRoleDto[]> {
    return this.rolesService.listRoles(serverId, user.id);
  }

  /**
   * POST /api/servers/:serverId/roles
   */
  @Post(':serverId/roles')
  createServerRole(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: CreateRoleDto,
  ): Promise<ServerRoleDto> {
    return this.rolesService.createRole(serverId, user.id, dto);
  }

  /**
   * PATCH /api/servers/:serverId/roles/:roleId
   */
  @Patch(':serverId/roles/:roleId')
  updateServerRole(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<ServerRoleDto> {
    return this.rolesService.updateRole(serverId, roleId, user.id, dto);
  }

  /**
   * DELETE /api/servers/:serverId/roles/:roleId
   */
  @Delete(':serverId/roles/:roleId')
  deleteServerRole(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('roleId') roleId: string,
  ): Promise<{ success: boolean }> {
    return this.rolesService.deleteRole(serverId, roleId, user.id);
  }

  /**
   * POST /api/servers/:serverId/members/:userId/roles/:roleId
   */
  @Post(':serverId/members/:userId/roles/:roleId')
  assignMemberRole(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('userId') targetUserId: string,
    @Param('roleId') roleId: string,
  ): Promise<{ success: boolean; capabilities: any }> {
    return this.rolesService.assignMemberRole(serverId, targetUserId, roleId, user.id);
  }

  /**
   * DELETE /api/servers/:serverId/members/:userId/roles/:roleId
   */
  @Delete(':serverId/members/:userId/roles/:roleId')
  removeMemberRole(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('userId') targetUserId: string,
    @Param('roleId') roleId: string,
  ): Promise<{ success: boolean; capabilities: any }> {
    return this.rolesService.removeMemberRole(serverId, targetUserId, roleId, user.id);
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

  /**
   * DELETE /api/servers/:serverId/members/:targetUserId
   * Trục xuất (Kick) thành viên khỏi máy chủ (Yêu cầu quyền KICK_MEMBERS hoặc Owner/Admin)
   */
  @Delete(':serverId/members/:targetUserId')
  @HttpCode(HttpStatus.OK)
  kickServerMember(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('targetUserId') targetUserId: string,
  ): Promise<{ success: boolean; serverId: string; targetUserId: string }> {
    return this.servers.kickServerMember(user.id, serverId, targetUserId);
  }

  /**
   * POST /api/servers/:serverId/bans
   * Cấm (Ban) thành viên khỏi máy chủ (Yêu cầu quyền BAN_MEMBERS hoặc Owner/Admin)
   */
  @Post(':serverId/bans')
  @HttpCode(HttpStatus.CREATED)
  banServerMember(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: CreateServerBanDto,
  ): Promise<{ success: boolean; serverId: string; targetUserId: string; reason?: string }> {
    return this.servers.banServerMember(user.id, serverId, dto.targetUserId, dto.reason);
  }

  /**
   * GET /api/servers/:serverId/bans
   * Lấy danh sách các thành viên bị cấm trong máy chủ
   */
  @Get(':serverId/bans')
  @HttpCode(HttpStatus.OK)
  listServerBans(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ) {
    return this.servers.listServerBans(user.id, serverId);
  }

  /**
   * DELETE /api/servers/:serverId/bans/:targetUserId
   * Bỏ cấm (Unban) thành viên khỏi máy chủ (Yêu cầu quyền BAN_MEMBERS hoặc Owner/Admin)
   */
  @Delete(':serverId/bans/:targetUserId')
  @HttpCode(HttpStatus.OK)
  unbanServerMember(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('targetUserId') targetUserId: string,
  ): Promise<{ success: boolean; serverId: string; targetUserId: string }> {
    return this.servers.unbanServerMember(user.id, serverId, targetUserId);
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
  getInvitePreview(
    @Param('code') code: string,
  ): Promise<ServerInvitePreviewDto> {
    return this.invites.getInvitePreview(code);
  }

  @Post(':code/join')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  joinByInviteCode(
    @CurrentUser() user: User,
    @Param('code') code: string,
  ): Promise<{
    success: boolean;
    serverId: string;
    channelId?: string;
    alreadyMember: boolean;
  }> {
    return this.invites.joinByInviteCode(user.id, code);
  }
}

/**
 * Controller công khai xem trước thông tin máy chủ.
 *
 * Tách riêng khỏi `ServersController` (đang `@UseGuards(SupabaseAuthGuard)` ở cấp
 * class) vì route này CỐ Ý không cần đăng nhập — để người nhận link giới thiệu
 * `origin/channels/:serverId` xem được card dù chưa vào server, giống
 * `InvitesController` cho link mời. Route `:serverId/preview` là đoạn literal
 * riêng nên không đụng các route `:serverId/...` có guard của controller kia.
 */
@Controller('servers')
export class ServerPreviewController {
  constructor(private readonly servers: ServersService) {}

  @Get(':serverId/preview')
  @HttpCode(HttpStatus.OK)
  getServerPreview(
    @Param('serverId') serverId: string,
  ): Promise<ServerPreviewDto> {
    return this.servers.getServerPreview(serverId);
  }
}
