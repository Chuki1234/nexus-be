import { BadRequestException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ChatGateway } from '../realtime/chat.gateway';
import { ServerInvitesService } from './server-invites.service';
import { ServerPermissionsService } from './server-permissions.service';

describe('ServerInvitesService', () => {
  let service: ServerInvitesService;
  let supabaseMock: any;
  let permissionsMock: any;
  let chatGatewayMock: any;

  beforeEach(async () => {
    supabaseMock = {
      client: {
        from: jest.fn(),
        rpc: jest.fn(),
      },
    };

    permissionsMock = {
      assertCanInvite: jest.fn().mockResolvedValue(undefined),
      assertCanManageServer: jest.fn().mockResolvedValue(undefined),
    };

    chatGatewayMock = {
      emitInvitationReceived: jest.fn(),
      emitInvitationUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServerInvitesService,
        { provide: SupabaseService, useValue: supabaseMock },
        { provide: ServerPermissionsService, useValue: permissionsMock },
        { provide: ChatGateway, useValue: chatGatewayMock },
      ],
    }).compile();

    service = module.get<ServerInvitesService>(ServerInvitesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createInviteLink', () => {
    it('creates 128-bit high-entropy invite link and returns ServerInviteLinkResponseDto', async () => {
      const userId = 'u-1';
      const serverId = 'srv-1';

      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'invites') {
          return {
            insert: jest.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === 'servers') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: { name: 'Super Server', icon_url: null } }),
          };
        }
        return {};
      });

      const res = await service.createInviteLink(userId, serverId, { maxUses: 5, expiresInSeconds: 3600 });
      expect(res.code).toBeDefined();
      expect(res.code.length).toBeGreaterThanOrEqual(16);
      expect(res.invitePath).toBe(`/invite/${res.code}`);
      expect(res.inviteUrl).toContain(`/invite/${res.code}`);
      expect(res.serverId).toBe(serverId);
      expect(res.serverName).toBe('Super Server');
      expect(res.maxUses).toBe(5);
    });

    it('throws InternalServerErrorException in Production when PUBLIC_WEB_URL is missing (fail-fast)', async () => {
      const oldEnv = process.env.NODE_ENV;
      const oldUrl = process.env.PUBLIC_WEB_URL;
      const oldFrontendUrl = process.env.FRONTEND_URL;

      process.env.NODE_ENV = 'production';
      delete process.env.PUBLIC_WEB_URL;
      delete process.env.FRONTEND_URL;

      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'invites') {
          return { insert: jest.fn().mockResolvedValue({ error: null }) };
        }
        if (table === 'servers') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: { name: 'Prod Server' } }),
          };
        }
        return {};
      });

      await expect(
        service.createInviteLink('u-1', 'srv-1', {}),
      ).rejects.toThrow(InternalServerErrorException);

      process.env.NODE_ENV = oldEnv;
      if (oldUrl) process.env.PUBLIC_WEB_URL = oldUrl;
      if (oldFrontendUrl) process.env.FRONTEND_URL = oldFrontendUrl;
    });
  });

  describe('getInvitePreview', () => {
    it('returns ServerInvitePreviewDto with valid status when not expired or max used', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'invites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                code: 'code-valid',
                server_id: 'srv-1',
                channel_id: 'chan-1',
                inviter_id: 'inviter-uuid',
                max_uses: 10,
                uses: 2,
                expires_at: new Date(Date.now() + 100000).toISOString(),
                servers: { name: 'Game Server', icon_url: 'http://icon.png' },
                channels: { name: 'general' },
              },
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { username: 'inviter_u', display_name: 'Inviter Guy', avatar_url: null },
            }),
          };
        }
        if (table === 'server_members') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({ count: 42 }),
          };
        }
        return {};
      });

      const preview = await service.getInvitePreview('code-valid');
      expect(preview.status).toBe('valid');
      expect(preview.isExpired).toBe(false);
      expect(preview.isMaxUsed).toBe(false);
      expect(preview.serverId).toBe('srv-1');
      expect(preview.channelId).toBe('chan-1');
      expect(preview.serverName).toBe('Game Server');
      expect(preview.channelName).toBe('general');
      expect(preview.inviterDisplayName).toBe('Inviter Guy');
      expect(preview.memberCount).toBe(42);
    });

    it('returns status: expired and isExpired: true when expires_at is past', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'invites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                code: 'code-expired',
                server_id: 'srv-1',
                channel_id: null,
                max_uses: null,
                uses: 0,
                expires_at: new Date(Date.now() - 10000).toISOString(),
                servers: { name: 'Old Server', icon_url: null },
                channels: null,
                inviter: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'server_members') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({ count: 5 }),
          };
        }
        return {};
      });

      const preview = await service.getInvitePreview('code-expired');
      expect(preview.status).toBe('expired');
      expect(preview.isExpired).toBe(true);
      expect(preview.isMaxUsed).toBe(false);
    });

    it('returns status: max_used and isMaxUsed: true when uses >= max_uses', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'invites') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                code: 'code-max',
                server_id: 'srv-1',
                channel_id: null,
                max_uses: 5,
                uses: 5,
                expires_at: null,
                servers: { name: 'Busy Server', icon_url: null },
                channels: null,
                inviter: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'server_members') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({ count: 10 }),
          };
        }
        return {};
      });

      const preview = await service.getInvitePreview('code-max');
      expect(preview.status).toBe('max_used');
      expect(preview.isMaxUsed).toBe(true);
      expect(preview.isExpired).toBe(false);
    });

    it('throws NotFoundException when invite code is not found in database', async () => {
      supabaseMock.client.from.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      }));

      await expect(service.getInvitePreview('code-nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('joinByInviteCode', () => {
    it('invokes join_server_by_invite_code RPC', async () => {
      supabaseMock.client.rpc.mockResolvedValue({
        data: { success: true, serverId: 'srv-1', channelId: 'chan-1', alreadyMember: false },
        error: null,
      });

      const res = await service.joinByInviteCode('user-1', 'code-123');
      expect(supabaseMock.client.rpc).toHaveBeenCalledWith('join_server_by_invite_code', {
        p_code: 'code-123',
        p_user_id: 'user-1',
      });
      expect(res.success).toBe(true);
      expect(res.alreadyMember).toBe(false);
    });
  });

  describe('acceptInvitation', () => {
    it('invokes accept_server_invitation RPC and emits invitation-updated', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'server_invitations') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'inv-123', server_id: 'srv-1', inviter_id: 'u-inviter', invitee_id: 'user-1' },
            }),
          };
        }
        return {};
      });

      supabaseMock.client.rpc.mockResolvedValue({
        data: { success: true, serverId: 'srv-1', alreadyMember: false },
        error: null,
      });

      const res = await service.acceptInvitation('user-1', 'inv-123');
      expect(supabaseMock.client.rpc).toHaveBeenCalledWith('accept_server_invitation', {
        p_invitation_id: 'inv-123',
        p_user_id: 'user-1',
      });
      expect(res.success).toBe(true);
      expect(chatGatewayMock.emitInvitationUpdated).toHaveBeenCalledWith('u-inviter', 'user-1', {
        invitationId: 'inv-123',
        serverId: 'srv-1',
        inviteeId: 'user-1',
        status: 'accepted',
      });
    });

    it('throws BadRequestException when accept_server_invitation returns success: false', async () => {
      supabaseMock.client.from.mockImplementation(() => ({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      }));

      supabaseMock.client.rpc.mockResolvedValue({
        data: { success: false, reason: 'expired', message: 'Lời mời đã hết hạn' },
        error: null,
      });

      await expect(
        service.acceptInvitation('user-1', 'inv-expired'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('declineInvitation', () => {
    it('updates status to declined and emits invitation-updated', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'server_invitations') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'inv-dec', server_id: 'srv-1', inviter_id: 'u-inviter', invitee_id: 'user-1', status: 'pending' },
              error: null,
            }),
            update: jest.fn().mockReturnThis(),
          };
        }
        return {};
      });

      const res = await service.declineInvitation('user-1', 'inv-dec');
      expect(res.success).toBe(true);
      expect(chatGatewayMock.emitInvitationUpdated).toHaveBeenCalledWith('u-inviter', 'user-1', {
        invitationId: 'inv-dec',
        serverId: 'srv-1',
        inviteeId: 'user-1',
        status: 'declined',
      });
    });
  });

  describe('listPendingInvitations', () => {
    it('returns pending invitations with batch-loaded inviter profile metadata', async () => {
      supabaseMock.client.from.mockImplementation((table: string) => {
        if (table === 'server_invitations') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            gt: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'inv-1',
                  server_id: 'srv-1',
                  inviter_id: 'u-1',
                  status: 'pending',
                  created_at: new Date().toISOString(),
                  expires_at: new Date(Date.now() + 100000).toISOString(),
                  servers: { name: 'Alpha Server', icon_url: null },
                },
              ],
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [{ id: 'u-1', username: 'alpha_inv', display_name: 'Alpha Guy', avatar_url: null }],
            }),
          };
        }
        return {};
      });

      const list = await service.listPendingInvitations('user-me');
      expect(list.length).toBe(1);
      expect(list[0].id).toBe('inv-1');
      expect(list[0].serverName).toBe('Alpha Server');
      expect(list[0].inviterDisplayName).toBe('Alpha Guy');
    });
  });
});
