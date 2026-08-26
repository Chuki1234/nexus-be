import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { Permission } from '../../shared/permissions';
import { ServerPermissionsService } from './server-permissions.service';

describe('ServerPermissionsService', () => {
  let service: ServerPermissionsService;
  let supabaseMock: { client: { from: jest.Mock } };

  beforeEach(async () => {
    supabaseMock = {
      client: {
        from: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServerPermissionsService,
        {
          provide: SupabaseService,
          useValue: supabaseMock,
        },
      ],
    }).compile();

    service = module.get<ServerPermissionsService>(ServerPermissionsService);
  });

  const mockServerQuery = (ownerId: string | null) => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(
      ownerId ? { data: { id: 'srv-1', owner_id: ownerId }, error: null } : { data: null, error: null },
    ),
  });

  const mockMemberQuery = (role: string | null) => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(
      role ? { data: { role }, error: null } : { data: null, error: null },
    ),
  });

  const mockRolesQuery = (roles: Array<{ id: string; permissions: number | string; is_default: boolean }>) => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockResolvedValue({ data: roles, error: null }),
  });

  const mockMemberRolesQuery = (roleIds: string[]) => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    then: jest.fn((resolve) => resolve({ data: roleIds.map((id) => ({ role_id: id })), error: null })),
  });

  it('throws NotFoundException when server does not exist', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery(null);
      return {};
    });

    await expect(service.getCapabilities('user-1', 'srv-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when user is not a member of server', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('other-owner');
      if (table === 'server_members') return mockMemberQuery(null);
      return {};
    });

    await expect(service.getCapabilities('user-1', 'srv-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('grants full capabilities when user is server owner_id', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('user-1');
      if (table === 'server_members') return mockMemberQuery('MEMBER');
      return {};
    });

    const caps = await service.getCapabilities('user-1', 'srv-1');
    expect(caps).toEqual({
      isOwner: true,
      canInviteMembers: true,
      canManageServer: true,
      canManageChannels: true,
      canManageRoles: true,
    });
  });

  it('grants full capabilities when user has legacy role OWNER', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('some-id');
      if (table === 'server_members') return mockMemberQuery('OWNER');
      return {};
    });

    const caps = await service.getCapabilities('user-1', 'srv-1');
    expect(caps).toEqual({
      isOwner: true,
      canInviteMembers: true,
      canManageServer: true,
      canManageChannels: true,
      canManageRoles: true,
    });
  });

  it('grants administrator capabilities to legacy ADMIN role without losing permissions', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('owner-id');
      if (table === 'server_members') return mockMemberQuery('ADMIN');
      return {};
    });

    const caps = await service.getCapabilities('user-admin', 'srv-1');
    expect(caps).toEqual({
      isOwner: false,
      canInviteMembers: true,
      canManageServer: true,
      canManageChannels: true,
      canManageRoles: true,
    });
  });

  it('evaluates bitfield correctly: regular member with default 3339n has canInviteMembers=true', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('owner-id');
      if (table === 'server_members') return mockMemberQuery('MEMBER');
      if (table === 'roles') {
        return mockRolesQuery([
          { id: 'role-everyone', permissions: 3339, is_default: true },
        ]);
      }
      if (table === 'member_roles') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({ data: [], error: null }),
          })),
        };
      }
      return {};
    });

    const caps = await service.getCapabilities('user-member', 'srv-1');
    expect(caps).toEqual({
      isOwner: false,
      canInviteMembers: true, // 3339n contains CREATE_INVITE (256n)
      canManageServer: false,
      canManageChannels: false,
      canManageRoles: false,
    });
  });

  it('grants canManageChannels when user is assigned a role with MANAGE_CHANNELS (16n)', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('owner-id');
      if (table === 'server_members') return mockMemberQuery('MEMBER');
      if (table === 'roles') {
        return mockRolesQuery([
          { id: 'role-everyone', permissions: 3339, is_default: true },
          { id: 'role-mod', permissions: 16, is_default: false }, // MANAGE_CHANNELS = 16n
        ]);
      }
      if (table === 'member_roles') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({ data: [{ role_id: 'role-mod' }], error: null }),
          })),
        };
      }
      return {};
    });

    const caps = await service.getCapabilities('user-mod', 'srv-1');
    expect(caps.canManageChannels).toBe(true);
    expect(caps.canManageServer).toBe(false);
    expect(caps.canManageRoles).toBe(false);
  });

  it('denies invite when CREATE_INVITE is removed from @everyone (0n)', async () => {
    supabaseMock.client.from.mockImplementation((table: string) => {
      if (table === 'servers') return mockServerQuery('owner-id');
      if (table === 'server_members') return mockMemberQuery('MEMBER');
      if (table === 'roles') {
        return mockRolesQuery([
          { id: 'role-everyone', permissions: 0, is_default: true },
        ]);
      }
      if (table === 'member_roles') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockImplementation(() => ({
            eq: jest.fn().mockResolvedValue({ data: [], error: null }),
          })),
        };
      }
      return {};
    });

    const caps = await service.getCapabilities('user-guest', 'srv-1');
    expect(caps.canInviteMembers).toBe(false);
  });

  describe('getChannelPermissions & assertions with channel_overwrites (target_type / target_id)', () => {
    const mockChannelQuery = (serverId: string | null) => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue(
        serverId ? { data: { id: 'chan-1', server_id: serverId }, error: null } : { data: null, error: null },
      ),
    });

    it('calculates regular member permissions using @everyone and channel overwrites correctly', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
            { id: 'role-mod', permissions: 3355, is_default: false },
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [{ role_id: 'role-mod' }], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                // @everyone overwrite: deny SEND_MESSAGES (2n)
                { target_type: 'role', target_id: 'role-everyone', allow: 1, deny: 2 },
                // role-mod overwrite: allow SEND_MESSAGES (2n)
                { target_type: 'role', target_id: 'role-mod', allow: 2, deny: 0 },
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      const perms = await service.getChannelPermissions('user-mod', 'chan-1');
      expect((perms & Permission.VIEW_CHANNEL) !== 0n).toBe(true);
      expect((perms & Permission.SEND_MESSAGES) !== 0n).toBe(true);

      await expect(service.assertChannelSend('user-mod', 'chan-1')).resolves.toBeUndefined();
    });

    it('applies member-specific overwrite with highest priority over role denies', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
            { id: 'role-muted', permissions: 0, is_default: false },
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [{ role_id: 'role-muted' }], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                // role-muted denies SEND_MESSAGES (2n)
                { target_type: 'role', target_id: 'role-muted', allow: 0, deny: 2 },
                // member-specific allows SEND_MESSAGES (2n)
                { target_type: 'member', target_id: 'user-vip', allow: 2, deny: 0 },
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      const perms = await service.getChannelPermissions('user-vip', 'chan-1');
      expect((perms & Permission.SEND_MESSAGES) !== 0n).toBe(true);
      await expect(service.assertChannelSend('user-vip', 'chan-1')).resolves.toBeUndefined();
    });

    it('throws ForbiddenException when VIEW_CHANNEL is denied', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                { target_type: 'role', target_id: 'role-everyone', allow: 0, deny: 1 }, // Deny VIEW_CHANNEL
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.assertChannelView('user-member', 'chan-1')).rejects.toThrow(ForbiddenException);
      await expect(service.assertChannelSend('user-member', 'chan-1')).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when ATTACH_FILES is denied for user attempting to attach file', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                { target_type: 'member', target_id: 'user-member', allow: 3, deny: 8 }, // Deny ATTACH_FILES (8n)
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.assertChannelSend('user-member', 'chan-1')).resolves.toBeUndefined();
      await expect(service.assertChannelAttach('user-member', 'chan-1')).rejects.toThrow(ForbiddenException);
    });

    it('Blocker 3: MANAGE_CHANNELS (16n) bị deny bởi channel overwrite thì assertChannelManage ném ForbiddenException', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
            { id: 'role-mod', permissions: 3355, is_default: false }, // Có MANAGE_CHANNELS (16n)
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [{ role_id: 'role-mod' }], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                // Channel overwrite deny MANAGE_CHANNELS (16n)
                { target_type: 'role', target_id: 'role-mod', allow: 0, deny: 16 },
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.assertChannelManage('user-mod', 'chan-1')).rejects.toThrow(ForbiddenException);
    });

    it('Blocker 3: Member-specific allow MANAGE_CHANNELS có precedence cao hơn role deny overwrite', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
            { id: 'role-mod', permissions: 3355, is_default: false },
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [{ role_id: 'role-mod' }], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                { target_type: 'role', target_id: 'role-mod', allow: 0, deny: 16 },
                { target_type: 'member', target_id: 'user-vip-mod', allow: 16, deny: 0 },
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.assertChannelManage('user-vip-mod', 'chan-1')).resolves.toBeUndefined();
    });

    it('Blocker 3: ADMINISTRATOR thật sự bypass toàn bộ channel overwrites cho MANAGE_CHANNELS', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'channels') return mockChannelQuery('srv-1');
        if (table === 'servers') return mockServerQuery('owner-id');
        if (table === 'server_members') return mockMemberQuery('MEMBER');
        if (table === 'roles') {
          return mockRolesQuery([
            { id: 'role-everyone', permissions: 3339, is_default: true },
            { id: 'role-admin', permissions: String(Permission.ADMINISTRATOR), is_default: false },
          ]);
        }
        if (table === 'member_roles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockImplementation(() => ({
              eq: jest.fn().mockResolvedValue({ data: [{ role_id: 'role-admin' }], error: null }),
            })),
          };
        }
        if (table === 'channel_overwrites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                { target_type: 'member', target_id: 'user-admin', allow: 0, deny: 16 }, // Deny attempt
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.assertChannelManage('user-admin', 'chan-1')).resolves.toBeUndefined();
    });
  });
});
