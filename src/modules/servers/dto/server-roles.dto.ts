export interface RolePermissionsDto {
  administrator: boolean;
  manageServer: boolean;
  manageRoles: boolean;
  kickMembers: boolean;
  banMembers: boolean;
  manageChannels: boolean;
}

export class CreateRoleDto {
  name!: string;
  color?: string;
  permissions?: Partial<RolePermissionsDto>;
}

export class UpdateRoleDto {
  name?: string;
  color?: string;
  permissions?: Partial<RolePermissionsDto>;
  position?: number;
}

export interface ServerRoleDto {
  id: string;
  serverId: string;
  name: string;
  color: string;
  permissions: RolePermissionsDto;
  position: number;
  isDefault: boolean;
  membersCount: number;
}
