import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ServerPermissionsService } from './server-permissions.service';
import { ChatGateway, Room } from '../realtime/chat.gateway';
import { Permission, DEFAULT_EVERYONE_PERMISSIONS } from '../../shared/permissions';
import {
  CreateRoleDto,
  RolePermissionsDto,
  ServerRoleDto,
  UpdateRoleDto,
} from './dto/server-roles.dto';

function hexColorToInt(hex?: string): number {
  if (!hex || !hex.startsWith('#')) return 0;
  const num = parseInt(hex.replace('#', ''), 16);
  return isNaN(num) ? 0 : num;
}

function intColorToHex(num: number): string {
  if (!num) return '#99aab5';
  return '#' + num.toString(16).padStart(6, '0');
}

function permissionsToBitmask(perms?: Partial<RolePermissionsDto>): bigint {
  if (!perms) return 0n;
  let mask = 0n;
  if (perms.administrator) mask |= Permission.ADMINISTRATOR;
  if (perms.manageServer) mask |= Permission.MANAGE_SERVER;
  if (perms.manageRoles) mask |= Permission.MANAGE_ROLES;
  if (perms.kickMembers) mask |= Permission.KICK_MEMBERS;
  if (perms.banMembers) mask |= Permission.BAN_MEMBERS;
  if (perms.manageChannels) mask |= Permission.MANAGE_CHANNELS;
  return mask;
}

function bitmaskToPermissions(mask: bigint): RolePermissionsDto {
  const isAdmin = (mask & Permission.ADMINISTRATOR) !== 0n;
  return {
    administrator: isAdmin,
    manageServer: isAdmin || (mask & Permission.MANAGE_SERVER) !== 0n,
    manageRoles: isAdmin || (mask & Permission.MANAGE_ROLES) !== 0n,
    kickMembers: isAdmin || (mask & Permission.KICK_MEMBERS) !== 0n,
    banMembers: isAdmin || (mask & Permission.BAN_MEMBERS) !== 0n,
    manageChannels: isAdmin || (mask & Permission.MANAGE_CHANNELS) !== 0n,
  };
}

@Injectable()
export class ServerRolesService {
  private readonly logger = new Logger(ServerRolesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly permissionsService: ServerPermissionsService,
    private readonly chatGateway: ChatGateway,
  ) {}

  async listRoles(serverId: string, userId: string): Promise<ServerRoleDto[]> {
    // 1. Kiểm tra caller là thành viên server
    const { data: myMembership, error: myMemErr } = await this.supabase.client
      .from('server_members')
      .select('role')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .maybeSingle();

    if (myMemErr) {
      this.logger.error(`Lỗi kiểm tra quyền xem server roles: ${myMemErr.message}`);
      throw new InternalServerErrorException('Lỗi xác thực thành viên.');
    }
    if (!myMembership) {
      throw new ForbiddenException('Bạn không phải là thành viên của máy chủ này.');
    }

    // 2. Lấy danh sách roles từ DB
    const { data: rolesData, error: rolesErr } = await this.supabase.client
      .from('roles')
      .select('id, server_id, name, color, permissions, position, is_default, created_at')
      .eq('server_id', serverId)
      .order('position', { ascending: false })
      .order('created_at', { ascending: true });

    if (rolesErr) {
      this.logger.error(`Lấy roles thất bại: ${rolesErr.message}`);
      throw new InternalServerErrorException('Lỗi tải danh sách vai trò.');
    }

    let roles = rolesData || [];

    // Đảm bảo luôn có role default @everyone
    if (!roles.some((r) => r.is_default)) {
      const { data: newDefault, error: defErr } = await this.supabase.client
        .from('roles')
        .insert({
          server_id: serverId,
          name: '@everyone',
          color: 0,
          permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(),
          position: 0,
          is_default: true,
        })
        .select('id, server_id, name, color, permissions, position, is_default, created_at')
        .single();

      if (!defErr && newDefault) {
        roles = [...roles, newDefault];
      }
    }

    // 3. Đếm số lượng thành viên cho mỗi role
    const { data: memberRolesData } = await this.supabase.client
      .from('member_roles')
      .select('role_id')
      .eq('server_id', serverId);

    const countsMap = new Map<string, number>();
    for (const mr of memberRolesData || []) {
      countsMap.set(mr.role_id, (countsMap.get(mr.role_id) || 0) + 1);
    }

    // Đếm tổng số thành viên server cho @everyone
    const { count: totalMembers } = await this.supabase.client
      .from('server_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('server_id', serverId);

    return roles.map((r) => {
      let mask = 0n;
      try {
        mask = BigInt(r.permissions ?? 0);
      } catch {}

      const isDefault = Boolean(r.is_default);
      const membersCount = isDefault
        ? (totalMembers ?? 1)
        : (countsMap.get(r.id) || 0);

      return {
        id: r.id,
        serverId: r.server_id,
        name: r.name,
        color: intColorToHex(r.color),
        permissions: bitmaskToPermissions(mask),
        position: r.position ?? 0,
        isDefault,
        membersCount,
      };
    });
  }

  async createRole(serverId: string, userId: string, dto: CreateRoleDto): Promise<ServerRoleDto> {
    await this.permissionsService.assertCanManageRoles(userId, serverId);

    const trimmedName = dto.name?.trim();
    if (!trimmedName || trimmedName.length > 32) {
      throw new BadRequestException('Tên vai trò phải từ 1 đến 32 ký tự.');
    }

    // Lấy position cao nhất hiện tại
    const { data: maxRole } = await this.supabase.client
      .from('roles')
      .select('position')
      .eq('server_id', serverId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextPosition = (maxRole?.position ?? 0) + 1;
    const bitmask = permissionsToBitmask(dto.permissions);
    const colorInt = hexColorToInt(dto.color);

    const { data: created, error } = await this.supabase.client
      .from('roles')
      .insert({
        server_id: serverId,
        name: trimmedName,
        color: colorInt,
        permissions: bitmask.toString(),
        position: nextPosition,
        is_default: false,
      })
      .select('id, server_id, name, color, permissions, position, is_default, created_at')
      .single();

    if (error || !created) {
      this.logger.error(`Tạo role thất bại: ${error?.message}`);
      throw new InternalServerErrorException('Không thể tạo vai trò mới.');
    }

    let mask = 0n;
    try {
      mask = BigInt(created.permissions ?? 0);
    } catch {}

    return {
      id: created.id,
      serverId: created.server_id,
      name: created.name,
      color: intColorToHex(created.color),
      permissions: bitmaskToPermissions(mask),
      position: created.position,
      isDefault: false,
      membersCount: 0,
    };
  }

  async updateRole(
    serverId: string,
    roleId: string,
    userId: string,
    dto: UpdateRoleDto,
  ): Promise<ServerRoleDto> {
    await this.permissionsService.assertCanManageRoles(userId, serverId);

    const { data: existing, error: findErr } = await this.supabase.client
      .from('roles')
      .select('id, server_id, name, color, permissions, position, is_default')
      .eq('id', roleId)
      .eq('server_id', serverId)
      .maybeSingle();

    if (findErr || !existing) {
      throw new NotFoundException('Vai trò không tồn tại.');
    }

    const updates: Record<string, any> = {};

    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (!trimmed || trimmed.length > 32) {
        throw new BadRequestException('Tên vai trò phải từ 1 đến 32 ký tự.');
      }
      if (!existing.is_default) {
        updates.name = trimmed;
      }
    }

    if (dto.color !== undefined) {
      updates.color = hexColorToInt(dto.color);
    }

    if (dto.permissions !== undefined) {
      const bitmask = permissionsToBitmask(dto.permissions);
      updates.permissions = bitmask.toString();
    }

    if (dto.position !== undefined && !existing.is_default) {
      updates.position = dto.position;
    }

    const { data: updated, error: updateErr } = await this.supabase.client
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .select('id, server_id, name, color, permissions, position, is_default')
      .single();

    if (updateErr || !updated) {
      this.logger.error(`Cập nhật role thất bại: ${updateErr?.message}`);
      throw new InternalServerErrorException('Không thể cập nhật vai trò.');
    }

    let mask = 0n;
    try {
      mask = BigInt(updated.permissions ?? 0);
    } catch {}

    return {
      id: updated.id,
      serverId: updated.server_id,
      name: updated.name,
      color: intColorToHex(updated.color),
      permissions: bitmaskToPermissions(mask),
      position: updated.position,
      isDefault: Boolean(updated.is_default),
      membersCount: 0,
    };
  }

  async deleteRole(serverId: string, roleId: string, userId: string): Promise<{ success: boolean }> {
    await this.permissionsService.assertCanManageRoles(userId, serverId);

    const { data: existing, error: findErr } = await this.supabase.client
      .from('roles')
      .select('id, is_default')
      .eq('id', roleId)
      .eq('server_id', serverId)
      .maybeSingle();

    if (findErr || !existing) {
      throw new NotFoundException('Vai trò không tồn tại.');
    }

    if (existing.is_default) {
      throw new BadRequestException('Không thể xóa vai trò mặc định @everyone.');
    }

    const { error: delErr } = await this.supabase.client
      .from('roles')
      .delete()
      .eq('id', roleId);

    if (delErr) {
      this.logger.error(`Xóa role thất bại: ${delErr.message}`);
      throw new InternalServerErrorException('Không thể xóa vai trò.');
    }

    return { success: true };
  }

  async assignMemberRole(
    serverId: string,
    targetUserId: string,
    roleId: string,
    callerUserId: string,
  ): Promise<{ success: boolean; capabilities: any }> {
    await this.permissionsService.assertCanManageRoles(callerUserId, serverId);

    // 1. Kiểm tra role tồn tại trong server
    const { data: role, error: roleErr } = await this.supabase.client
      .from('roles')
      .select('id, is_default')
      .eq('id', roleId)
      .eq('server_id', serverId)
      .maybeSingle();

    if (roleErr || !role) {
      throw new NotFoundException('Vai trò không tồn tại trong máy chủ.');
    }

    if (role.is_default) {
      throw new BadRequestException('Vai trò @everyone được áp dụng tự động.');
    }

    // 2. Kiểm tra target user là thành viên
    const { data: member, error: memErr } = await this.supabase.client
      .from('server_members')
      .select('user_id')
      .eq('server_id', serverId)
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (memErr || !member) {
      throw new NotFoundException('Người dùng không phải là thành viên máy chủ.');
    }

    // 3. Gán role vào member_roles
    const { error: insertErr } = await this.supabase.client
      .from('member_roles')
      .insert({
        role_id: roleId,
        user_id: targetUserId,
        server_id: serverId,
      });

    if (insertErr && insertErr.code !== '23505') {
      this.logger.error(`Gán role thất bại: ${insertErr.message}`);
      throw new InternalServerErrorException('Không thể gán vai trò.');
    }

    // 4. Tính toán lại capabilities và phát realtime socket
    const caps = await this.permissionsService.getCapabilities(targetUserId, serverId);
    try {
      this.chatGateway.emitCapabilitiesUpdated(targetUserId, serverId, caps);
      this.chatGateway.server
        ?.to(Room.server(serverId))
        .emit('server:member-role-updated', {
          serverId,
          userId: targetUserId,
          roleId,
          action: 'added',
        });
    } catch (err: any) {
      this.logger.warn(`Phát realtime role update thất bại: ${err?.message}`);
    }

    return { success: true, capabilities: caps };
  }

  async removeMemberRole(
    serverId: string,
    targetUserId: string,
    roleId: string,
    callerUserId: string,
  ): Promise<{ success: boolean; capabilities: any }> {
    await this.permissionsService.assertCanManageRoles(callerUserId, serverId);

    const { error: delErr } = await this.supabase.client
      .from('member_roles')
      .delete()
      .eq('server_id', serverId)
      .eq('user_id', targetUserId)
      .eq('role_id', roleId);

    if (delErr) {
      this.logger.error(`Gỡ role thất bại: ${delErr.message}`);
      throw new InternalServerErrorException('Không thể gỡ vai trò.');
    }

    // Tính toán lại capabilities và phát realtime socket
    const caps = await this.permissionsService.getCapabilities(targetUserId, serverId);
    try {
      this.chatGateway.emitCapabilitiesUpdated(targetUserId, serverId, caps);
      this.chatGateway.server
        ?.to(Room.server(serverId))
        .emit('server:member-role-updated', {
          serverId,
          userId: targetUserId,
          roleId,
          action: 'removed',
        });
    } catch (err: any) {
      this.logger.warn(`Phát realtime role update thất bại: ${err?.message}`);
    }

    return { success: true, capabilities: caps };
  }
}
