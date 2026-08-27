import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { SERVER_TEMPLATES } from './constants/server-templates.constant';
import { CreateServerDto } from './dto/create-server.dto';
import { ServerInvitesService } from './server-invites.service';
import { ServerPermissionsService } from './server-permissions.service';
import {
  InvitesController,
  ServerInvitationsController,
  ServersController,
  ServerTemplatesController,
} from './servers.controller';
import { ServersService } from './servers.service';

describe('ServersController', () => {
  let controller: ServersController;
  let templatesController: ServerTemplatesController;
  let invitationsController: ServerInvitationsController;
  let invitesController: InvitesController;
  let serversService: jest.Mocked<ServersService>;
  let permissionsService: jest.Mocked<ServerPermissionsService>;
  let invitesService: jest.Mocked<ServerInvitesService>;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
  } as User;

  beforeEach(async () => {
    const mockServersService = {
      getTemplates: jest.fn().mockReturnValue(SERVER_TEMPLATES),
      createServer: jest.fn(),
      listUserServers: jest.fn(),
      createChannel: jest.fn(),
      deleteServer: jest.fn(),
      leaveServer: jest.fn(),
    };

    const mockPermissionsService = {
      getCapabilities: jest.fn(),
      assertCanManageChannels: jest.fn(),
      assertCanInvite: jest.fn(),
      assertCanManageServer: jest.fn(),
    };

    const mockInvitesService = {
      getInviteCandidates: jest.fn(),
      createDirectInvitation: jest.fn(),
      listPendingInvitations: jest.fn(),
      acceptInvitation: jest.fn(),
      declineInvitation: jest.fn(),
      revokeDirectInvitation: jest.fn(),
      createInviteLink: jest.fn(),
      revokeInviteLink: jest.fn(),
      getInvitePreview: jest.fn(),
      joinByInviteCode: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [
        ServersController,
        ServerTemplatesController,
        ServerInvitationsController,
        InvitesController,
      ],
      providers: [
        { provide: ServersService, useValue: mockServersService },
        { provide: ServerPermissionsService, useValue: mockPermissionsService },
        { provide: ServerInvitesService, useValue: mockInvitesService },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ServersController>(ServersController);
    templatesController = module.get<ServerTemplatesController>(ServerTemplatesController);
    invitationsController = module.get<ServerInvitationsController>(ServerInvitationsController);
    invitesController = module.get<InvitesController>(InvitesController);
    serversService = module.get(ServersService);
    permissionsService = module.get(ServerPermissionsService);
    invitesService = module.get(ServerInvitesService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
    expect(templatesController).toBeDefined();
    expect(invitationsController).toBeDefined();
    expect(invitesController).toBeDefined();
  });

  describe('getCapabilities', () => {
    it('calls permissionsService.getCapabilities with userId and serverId', async () => {
      const caps = {
        isOwner: true,
        canInviteMembers: true,
        canManageServer: true,
        canManageChannels: true,
        canManageRoles: true,
        canKickMembers: true,
        canBanMembers: true,
      };
      permissionsService.getCapabilities.mockResolvedValue(caps);

      const result = await controller.getCapabilities(mockUser, 'server-1');
      expect(permissionsService.getCapabilities).toHaveBeenCalledWith('user-123', 'server-1');
      expect(result).toEqual(caps);
    });
  });

  describe('getTemplates', () => {
    it('should return server templates list', () => {
      const result = controller.getTemplates();
      expect(result).toBe(SERVER_TEMPLATES);
      expect(templatesController.getTemplates()).toBe(SERVER_TEMPLATES);
    });
  });

  describe('createServer', () => {
    it('should call serversService.createServer with authenticated user id and dto', async () => {
      const dto: CreateServerDto = {
        name: 'Máy chủ Gaming',
        templateId: 'gaming',
      };
      const expectedResponse = {
        server: {
          id: 'server-1',
          name: 'Máy chủ Gaming',
          templateId: 'gaming',
          iconUrl: null,
          unread: false,
          mentionCount: 0,
        },
        channels: [],
      };

      serversService.createServer.mockResolvedValue(expectedResponse);

      const result = await controller.createServer(mockUser, dto);
      expect(serversService.createServer).toHaveBeenCalledWith('user-123', dto);
      expect(result).toEqual(expectedResponse);
    });
  });

  describe('createChannel', () => {
    it('should call serversService.createChannel with user id, server id and dto', async () => {
      const dto = {
        name: 'kênh-mới',
        type: 'text' as const,
        topic: 'Chủ đề kênh',
      };
      const expectedChannel = {
        id: 'chan-new-1',
        name: 'kênh-mới',
        type: 'text' as const,
        topic: 'Chủ đề kênh',
        unread: false,
        mentionCount: 0,
      };

      serversService.createChannel.mockResolvedValue(expectedChannel);

      const result = await controller.createChannel(mockUser, 'server-1', dto);
      expect(serversService.createChannel).toHaveBeenCalledWith('user-123', 'server-1', dto);
      expect(result).toEqual(expectedChannel);
    });
  });

  describe('direct invitations and link invites', () => {
    it('handles invite candidates', async () => {
      invitesService.getInviteCandidates.mockResolvedValue([]);
      const res = await controller.getInviteCandidates(mockUser, 'srv-1');
      expect(invitesService.getInviteCandidates).toHaveBeenCalledWith('user-123', 'srv-1');
      expect(res).toEqual([]);
    });

    it('creates direct invitation', async () => {
      const invDto: any = { id: 'inv-1' };
      invitesService.createDirectInvitation.mockResolvedValue(invDto);
      const res = await controller.createDirectInvitation(mockUser, 'srv-1', { inviteeId: 'u-2' });
      expect(invitesService.createDirectInvitation).toHaveBeenCalledWith('user-123', 'srv-1', 'u-2');
      expect(res).toEqual(invDto);
    });

    it('revokes direct invitation', async () => {
      invitesService.revokeDirectInvitation.mockResolvedValue({ success: true });
      const res = await controller.revokeDirectInvitation(mockUser, 'srv-1', 'inv-1');
      expect(invitesService.revokeDirectInvitation).toHaveBeenCalledWith('user-123', 'srv-1', 'inv-1');
      expect(res.success).toBe(true);
    });

    it('creates invite link', async () => {
      const linkDto: any = { code: 'code-128', inviteUrl: 'https://app/invite/code-128' };
      invitesService.createInviteLink.mockResolvedValue(linkDto);
      const res = await controller.createInviteLink(mockUser, 'srv-1', {});
      expect(invitesService.createInviteLink).toHaveBeenCalledWith('user-123', 'srv-1', {});
      expect(res).toEqual(linkDto);
    });

    it('revokes invite link', async () => {
      invitesService.revokeInviteLink.mockResolvedValue({ success: true });
      const res = await controller.revokeInviteLink(mockUser, 'srv-1', 'code-128');
      expect(invitesService.revokeInviteLink).toHaveBeenCalledWith('user-123', 'srv-1', 'code-128');
      expect(res.success).toBe(true);
    });

    it('handles server invitations controller accept & decline', async () => {
      invitesService.acceptInvitation.mockResolvedValue({ success: true, serverId: 'srv-1', alreadyMember: false });
      const resAccept = await invitationsController.acceptInvitation(mockUser, 'inv-1');
      expect(resAccept.success).toBe(true);

      invitesService.declineInvitation.mockResolvedValue({ success: true });
      const resDecline = await invitationsController.declineInvitation(mockUser, 'inv-1');
      expect(resDecline.success).toBe(true);
    });

    it('handles invites controller preview & join', async () => {
      const previewDto: any = { serverName: 'Server' };
      invitesService.getInvitePreview.mockResolvedValue(previewDto);
      const resPreview = await invitesController.getInvitePreview('code-128');
      expect(resPreview).toEqual(previewDto);

      invitesService.joinByInviteCode.mockResolvedValue({ success: true, serverId: 'srv-1', alreadyMember: false });
      const resJoin = await invitesController.joinByInviteCode(mockUser, 'code-128');
      expect(resJoin.success).toBe(true);
    });

    it('deletes server via controller', async () => {
      serversService.deleteServer.mockResolvedValue({ success: true, serverId: 'srv-1' });
      const res = await controller.deleteServer(mockUser, 'srv-1');
      expect(serversService.deleteServer).toHaveBeenCalledWith('user-123', 'srv-1');
      expect(res.success).toBe(true);
    });

    it('leaves server via controller', async () => {
      serversService.leaveServer.mockResolvedValue({ success: true, serverId: 'srv-1', alreadyLeft: false });
      const res = await controller.leaveServer(mockUser, 'srv-1');
      expect(serversService.leaveServer).toHaveBeenCalledWith('user-123', 'srv-1');
      expect(res.success).toBe(true);
    });
  });
});
