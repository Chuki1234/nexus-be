import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { CurrentServerCapabilities } from '../../shared/dto/server-capabilities.dto';
import { Permission } from '../../shared/permissions';

@Injectable()
export class ServerPermissionsService {
  private readonly logger = new Logger(ServerPermissionsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Tính toán canonical server capabilities của một user trên server:
   * 1. Check membership và server existence. Non-member -> 403 Forbidden.
   * 2. Owner (server.owner_id === userId HOẶC server_members.role === 'OWNER') -> Full true.
   * 3. Legacy ADMIN (server_members.role === 'ADMIN') -> Map sang ADMINISTRATOR (Full true).
   * 4. DB Bitfield: @everyone role + member_roles ->
   *    - canInviteMembers: (basePerms & CREATE_INVITE) !== 0n
   *    - canManageServer: (basePerms & MANAGE_SERVER) !== 0n
   *    - canManageChannels: (basePerms & MANAGE_CHANNELS) !== 0n
   *    - canManageRoles: (basePerms & MANAGE_ROLES) !== 0n
   */
  async getCapabilities(
    userId: string,
    serverId: string,
  ): Promise<CurrentServerCapabilities> {
    const { data: server, error: serverError } = await this.supabase.client
      .from('servers')
      .select('id, owner_id')
      .eq('id', serverId)
      .maybeSingle();

    if (serverError) {
      this.logger.error(`Lấy thông tin server thất bại: ${serverError.message}`);
      throw new InternalServerErrorException('Lỗi kiểm tra quyền máy chủ.');
    }

    if (!server) {
      throw new NotFoundException('Máy chủ không tồn tại.');
    }

    const { data: membership, error: memberError } = await this.supabase.client
      .from('server_members')
      .select('role')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .maybeSingle();

    if (memberError) {
      this.logger.error(`Lấy membership thất bại: ${memberError.message}`);
      throw new InternalServerErrorException('Lỗi xác thực thành viên.');
    }

    if (!membership) {
      throw new ForbiddenException('Bạn không phải là thành viên của máy chủ này.');
    }

    // 1. Owner Precedence
    const isOwner = server.owner_id === userId || membership.role === 'OWNER';
    if (isOwner) {
      return {
        isOwner: true,
        canInviteMembers: true,
        canManageServer: true,
        canManageChannels: true,
        canManageRoles: true,
        canKickMembers: true,
        canBanMembers: true,
      };
    }

    // 2. Legacy ADMIN role mapping
    if (membership.role === 'ADMIN') {
      return {
        isOwner: false,
        canInviteMembers: true,
        canManageServer: true,
        canManageChannels: true,
        canManageRoles: true,
        canKickMembers: true,
        canBanMembers: true,
      };
    }

    // 3. Aggregate bitfield permissions from @everyone and member_roles
    const { data: rolesData, error: rolesError } = await this.supabase.client
      .from('roles')
      .select('id, permissions, is_default')
      .eq('server_id', serverId);

    if (rolesError) {
      this.logger.error(`Lấy roles thất bại: ${rolesError.message}`);
      throw new InternalServerErrorException('Lỗi kiểm tra phân quyền.');
    }

    const { data: assignedRoles, error: assignedError } = await this.supabase.client
      .from('member_roles')
      .select('role_id')
      .eq('server_id', serverId)
      .eq('user_id', userId);

    if (assignedError) {
      this.logger.error(`Lấy member_roles thất bại: ${assignedError.message}`);
      throw new InternalServerErrorException('Lỗi kiểm tra vai trò thành viên.');
    }

    const assignedRoleIds = new Set(
      (assignedRoles || []).map((r: { role_id: string }) => r.role_id),
    );

    let basePerms = 0n;
    for (const role of rolesData || []) {
      if (role.is_default || assignedRoleIds.has(role.id)) {
        try {
          const p = BigInt(role.permissions ?? 0);
          basePerms |= p;
        } catch {
          // ignore parsing error
        }
      }
    }

    const isAdmin = (basePerms & Permission.ADMINISTRATOR) !== 0n;

    return {
      isOwner: false,
      canInviteMembers: isAdmin || (basePerms & Permission.CREATE_INVITE) !== 0n,
      canManageServer: isAdmin || (basePerms & Permission.MANAGE_SERVER) !== 0n,
      canManageChannels: isAdmin || (basePerms & Permission.MANAGE_CHANNELS) !== 0n,
      canManageRoles: isAdmin || (basePerms & Permission.MANAGE_ROLES) !== 0n,
      canKickMembers: isAdmin || (basePerms & Permission.KICK_MEMBERS) !== 0n,
      canBanMembers: isAdmin || (basePerms & Permission.BAN_MEMBERS) !== 0n,
    };
  }

  async assertCanManageChannels(userId: string, serverId: string): Promise<void> {
    const caps = await this.getCapabilities(userId, serverId);
    if (!caps.canManageChannels) {
      throw new ForbiddenException('Bạn không có quyền quản lý kênh trong máy chủ này.');
    }
  }

  async assertCanInvite(userId: string, serverId: string): Promise<void> {
    const caps = await this.getCapabilities(userId, serverId);
    if (!caps.canInviteMembers) {
      throw new ForbiddenException('Bạn không có quyền tạo lời mời trong máy chủ này.');
    }
  }

  async assertCanManageServer(userId: string, serverId: string): Promise<void> {
    const caps = await this.getCapabilities(userId, serverId);
    if (!caps.canManageServer) {
      throw new ForbiddenException('Bạn không có quyền quản lý máy chủ này.');
    }
  }

  async assertCanManageRoles(userId: string, serverId: string): Promise<void> {
    const caps = await this.getCapabilities(userId, serverId);
    if (!caps.canManageRoles && !caps.isOwner) {
      throw new ForbiddenException('Bạn không có quyền quản lý vai trò trong máy chủ này.');
    }
  }

  async assertCanKickMembers(userId: string, serverId: string): Promise<void> {
    const caps = await this.getCapabilities(userId, serverId);
    if (!caps.canKickMembers && !caps.isOwner) {
      throw new ForbiddenException('Bạn không có quyền trục xuất thành viên trong máy chủ này.');
    }
  }

  async assertCanBanMembers(userId: string, serverId: string): Promise<void> {
    const caps = await this.getCapabilities(userId, serverId);
    if (!caps.canBanMembers && !caps.isOwner) {
      throw new ForbiddenException('Bạn không có quyền cấm thành viên trong máy chủ này.');
    }
  }

  /**
   * Tính quyền hiệu lực (Effective Permissions) của user trên một channel cụ thể
   * theo đúng thuật toán 5 bước chuẩn Discord bitfield.
   */
  async getChannelPermissions(userId: string, channelId: string): Promise<bigint> {
    const { data: channel, error: chanErr } = await this.supabase.client
      .from('channels')
      .select('id, server_id')
      .eq('id', channelId)
      .maybeSingle();

    if (chanErr) {
      this.logger.error(`Lấy thông tin channel thất bại: ${chanErr.message}`);
      throw new InternalServerErrorException('Lỗi kiểm tra kênh.');
    }

    if (!channel) {
      throw new NotFoundException('Kênh không tồn tại.');
    }

    const serverId = channel.server_id;

    // 1. Kiểm tra Server & Membership
    const { data: server, error: serverError } = await this.supabase.client
      .from('servers')
      .select('id, owner_id')
      .eq('id', serverId)
      .maybeSingle();

    if (serverError || !server) {
      throw new NotFoundException('Máy chủ không tồn tại.');
    }

    const { data: membership, error: memberError } = await this.supabase.client
      .from('server_members')
      .select('role')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .maybeSingle();

    if (memberError) {
      this.logger.error(`Lấy membership thất bại: ${memberError.message}`);
      throw new InternalServerErrorException('Lỗi xác thực thành viên.');
    }

    if (!membership) {
      throw new ForbiddenException('Bạn không phải là thành viên của máy chủ này.');
    }

    // Bước 1: Owner hoặc Legacy ADMIN
    const isOwner = server.owner_id === userId || membership.role === 'OWNER';
    if (isOwner || membership.role === 'ADMIN') {
      return Permission.ADMINISTRATOR | ~0n;
    }

    // Bước 2: Base Permissions (@everyone + assigned member roles)
    const { data: rolesData } = await this.supabase.client
      .from('roles')
      .select('id, permissions, is_default')
      .eq('server_id', serverId);

    const { data: assignedRoles } = await this.supabase.client
      .from('member_roles')
      .select('role_id')
      .eq('server_id', serverId)
      .eq('user_id', userId);

    const assignedRoleIds = new Set((assignedRoles || []).map((r: { role_id: string }) => r.role_id));

    let basePerms = 0n;
    let everyoneRoleId: string | null = null;

    for (const role of rolesData || []) {
      if (role.is_default) {
        everyoneRoleId = role.id;
      }
      if (role.is_default || assignedRoleIds.has(role.id)) {
        try {
          basePerms |= BigInt(role.permissions ?? 0);
        } catch {}
      }
    }

    if ((basePerms & Permission.ADMINISTRATOR) !== 0n) {
      return ~0n;
    }

    let perms = basePerms;

    // Lấy toàn bộ channel_overwrites của kênh này
    const { data: overwrites } = await this.supabase.client
      .from('channel_overwrites')
      .select('target_type, target_id, allow, deny')
      .eq('channel_id', channelId);

    const allOverwrites = overwrites || [];

    // Bước 3: @everyone overwrite
    if (everyoneRoleId) {
      const evOw = allOverwrites.find(
        (o: any) => o.target_type === 'role' && o.target_id === everyoneRoleId,
      );
      if (evOw) {
        const allow = BigInt(evOw.allow ?? 0);
        const deny = BigInt(evOw.deny ?? 0);
        perms = (perms & ~deny) | allow;
      }
    }

    // Bước 4: Aggregate assigned roles overwrites (OR toàn bộ deny, OR toàn bộ allow)
    let rolesDeny = 0n;
    let rolesAllow = 0n;
    for (const ow of allOverwrites) {
      if (
        ow.target_type === 'role' &&
        ow.target_id &&
        assignedRoleIds.has(ow.target_id) &&
        ow.target_id !== everyoneRoleId
      ) {
        rolesDeny |= BigInt(ow.deny ?? 0);
        rolesAllow |= BigInt(ow.allow ?? 0);
      }
    }
    perms = (perms & ~rolesDeny) | rolesAllow;

    // Bước 5: Member-specific overwrite cuối cùng
    const memOw = allOverwrites.find(
      (o: any) => o.target_type === 'member' && o.target_id === userId,
    );
    if (memOw) {
      const allow = BigInt(memOw.allow ?? 0);
      const deny = BigInt(memOw.deny ?? 0);
      perms = (perms & ~deny) | allow;
    }

    return perms;
  }

  async assertChannelView(userId: string, channelId: string): Promise<void> {
    const perms = await this.getChannelPermissions(userId, channelId);
    if ((perms & Permission.VIEW_CHANNEL) === 0n) {
      throw new ForbiddenException('Bạn không có quyền xem kênh này.');
    }
  }

  async assertChannelSend(userId: string, channelId: string): Promise<void> {
    const perms = await this.getChannelPermissions(userId, channelId);
    if ((perms & Permission.VIEW_CHANNEL) === 0n || (perms & Permission.SEND_MESSAGES) === 0n) {
      throw new ForbiddenException('Bạn không có quyền gửi tin nhắn trong kênh này.');
    }
  }

  async assertChannelAttach(userId: string, channelId: string): Promise<void> {
    const perms = await this.getChannelPermissions(userId, channelId);
    if (
      (perms & Permission.VIEW_CHANNEL) === 0n ||
      (perms & Permission.SEND_MESSAGES) === 0n ||
      (perms & Permission.ATTACH_FILES) === 0n
    ) {
      throw new ForbiddenException('Bạn không có quyền đính kèm tệp trong kênh này.');
    }
  }

  async assertChannelManage(userId: string, channelId: string): Promise<void> {
    const perms = await this.getChannelPermissions(userId, channelId);
    if (
      (perms & Permission.MANAGE_CHANNELS) === 0n &&
      (perms & Permission.ADMINISTRATOR) === 0n
    ) {
      throw new ForbiddenException('Bạn không có quyền quản lý kênh này.');
    }
  }
}
