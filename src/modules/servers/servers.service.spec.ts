import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { Room } from '../../shared/socket-events';
import { ChatGateway } from '../realtime/chat.gateway';
import { SERVER_TEMPLATES } from './constants/server-templates.constant';
import { CreateServerDto } from './dto/create-server.dto';
import { ServersService } from './servers.service';

describe('ServersService', () => {
  let service: ServersService;
  let supabaseService: { client: any };
  let chatGatewayMock: { server: { to: jest.Mock } };
  let emitMock: jest.Mock;

  beforeEach(async () => {
    emitMock = jest.fn();
    chatGatewayMock = {
      server: {
        to: jest.fn().mockReturnValue({
          emit: emitMock,
        }),
      },
    };

    supabaseService = {
      client: {
        rpc: jest.fn(),
        from: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServersService,
        {
          provide: SupabaseService,
          useValue: supabaseService,
        },
        {
          provide: ChatGateway,
          useValue: chatGatewayMock,
        },
      ],
    }).compile();

    service = module.get<ServersService>(ServersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTemplates', () => {
    it('should return canonical templates list', () => {
      const templates = service.getTemplates();
      expect(templates).toEqual(SERVER_TEMPLATES);
      expect(templates.length).toBe(5);
    });
  });

  describe('createServer', () => {
    it('should create a server with template channels successfully via RPC', async () => {
      const dto: CreateServerDto = {
        name: '  Không Gian Gaming  ',
        templateId: 'gaming',
      };
      const gamingTemplate = SERVER_TEMPLATES.find((t) => t.id === 'gaming')!;
      const expectedRpcResult = {
        server: {
          id: 's-123',
          name: 'Không Gian Gaming',
          templateId: 'gaming',
          iconUrl: null,
          unread: false,
          mentionCount: 0,
        },
        channels: gamingTemplate.channels.map((c, i) => ({
          id: `c-${i}`,
          name: c.name,
          type: c.type,
          topic: null,
          unread: false,
          mentionCount: 0,
        })),
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: expectedRpcResult,
        error: null,
      });

      const result = await service.createServer('user-1', dto);

      expect(supabaseService.client.rpc).toHaveBeenCalledWith(
        'create_server_with_template',
        {
          p_owner_id: 'user-1',
          p_name: 'Không Gian Gaming',
          p_template_id: 'gaming',
          p_channels: gamingTemplate.channels,
        },
      );
      expect(result).toEqual(expectedRpcResult);
    });

    it('should throw BadRequestException if templateId is unknown', async () => {
      const dto = {
        name: 'Server Test',
        templateId: 'unknown_tpl' as any,
      };

      await expect(service.createServer('user-1', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if RPC returns validation error code 22023', async () => {
      const dto: CreateServerDto = { name: 'A', templateId: 'custom' };

      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '22023',
          message: 'Tên máy chủ phải từ 2 đến 100 ký tự',
        },
      });

      await expect(service.createServer('user-1', dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw ServiceUnavailableException if RPC function is missing on Supabase', async () => {
      const dto: CreateServerDto = {
        name: 'Học Tập',
        templateId: 'study',
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '42883',
          message: 'function public.create_server_with_template does not exist',
        },
      });

      await expect(service.createServer('user-1', dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should throw ServiceUnavailableException if tables are missing on Supabase', async () => {
      const dto: CreateServerDto = {
        name: 'Học Tập',
        templateId: 'study',
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '42P01',
          message: 'relation public.servers does not exist',
        },
      });

      await expect(service.createServer('user-1', dto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should throw InternalServerErrorException on unexpected generic DB error', async () => {
      const dto: CreateServerDto = {
        name: 'Học Tập',
        templateId: 'study',
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '58030',
          message: 'io error on disk',
        },
      });

      await expect(service.createServer('user-1', dto)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('listUserServers', () => {
    it('should return empty array if user has no memberships', async () => {
      supabaseService.client.from.mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        }),
      });

      const result = await service.listUserServers('user-1');
      expect(result).toEqual([]);
    });

    it('should query servers and their channels in position order', async () => {
      const mockMemberships = [{ server_id: 's-1' }];
      const mockServers = [
        {
          id: 's-1',
          name: 'Server 1',
          template_id: 'gaming',
          icon_url: null,
          created_at: '2026-01-01',
        },
      ];
      const mockChannels = [
        {
          id: 'c-1',
          server_id: 's-1',
          name: 'chào-mừng',
          type: 'text',
          topic: null,
          position: 0,
        },
        {
          id: 'c-2',
          server_id: 's-1',
          name: 'Phòng chờ',
          type: 'voice',
          topic: null,
          position: 1,
        },
      ];

      supabaseService.client.from.mockImplementation((table: string) => {
        if (table === 'server_members') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: mockMemberships,
                error: null,
              }),
            }),
          };
        }
        if (table === 'servers') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue({
                  data: mockServers,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'channels') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockReturnValue({
                order: jest.fn().mockResolvedValue({
                  data: mockChannels,
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const result = await service.listUserServers('user-1');

      expect(result).toEqual([
        {
          id: 's-1',
          name: 'Server 1',
          templateId: 'gaming',
          iconUrl: null,
          unread: false,
          mentionCount: 0,
          channels: [
            {
              id: 'c-1',
              name: 'chào-mừng',
              type: 'text',
              topic: null,
              unread: false,
              mentionCount: 0,
            },
            {
              id: 'c-2',
              name: 'Phòng chờ',
              type: 'voice',
              topic: null,
              unread: false,
              mentionCount: 0,
            },
          ],
        },
      ]);
    });
  });

  describe('createChannel', () => {
    it('should create a channel successfully via create_server_channel RPC', async () => {
      const dto = {
        name: 'thảo-luận-mới',
        type: 'text' as const,
        topic: 'Thảo luận các chủ đề mới',
      };

      const mockCreated = {
        id: 'c-new-1',
        serverId: 'server-1',
        name: 'thảo-luận-mới',
        type: 'text',
        topic: 'Thảo luận các chủ đề mới',
        position: 3,
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: mockCreated,
        error: null,
      });

      const result = await service.createChannel('user-1', 'server-1', dto);

      expect(supabaseService.client.rpc).toHaveBeenCalledWith('create_server_channel', {
        p_server_id: 'server-1',
        p_user_id: 'user-1',
        p_name: 'thảo-luận-mới',
        p_type: 'text',
        p_topic: 'Thảo luận các chủ đề mới',
      });

      expect(result).toEqual({
        id: 'c-new-1',
        name: 'thảo-luận-mới',
        type: 'text',
        topic: 'Thảo luận các chủ đề mới',
        unread: false,
        mentionCount: 0,
      });
    });

    it('should throw ForbiddenException if RPC returns 42501 (not authorized)', async () => {
      const dto = {
        name: 'kenh-cam',
        type: 'text' as const,
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: { code: '42501', message: 'Bạn không có quyền quản lý kênh trong máy chủ này' },
      });

      await expect(
        service.createChannel('user-stranger', 'server-1', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if channel name is empty', async () => {
      await expect(
        service.createChannel('user-1', 'server-1', {
          name: '   ',
          type: 'text',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if RPC returns 23505 (duplicate channel name)', async () => {
      const dto = {
        name: 'chung',
        type: 'text' as const,
      };

      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });

      await expect(
        service.createChannel('user-1', 'server-1', dto),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteServer', () => {
    it('should successfully delete server via RPC and broadcast to server & user rooms', async () => {
      const serverId = 'srv-100';
      const ownerId = 'usr-owner';
      const memberIds = ['usr-owner', 'usr-alice', 'usr-bob'];

      supabaseService.client.rpc.mockResolvedValue({
        data: {
          success: true,
          serverId,
          memberUserIds: memberIds,
        },
        error: null,
      });

      const result = await service.deleteServer(ownerId, serverId);

      expect(result).toEqual({ success: true, serverId });
      expect(supabaseService.client.rpc).toHaveBeenCalledWith('delete_server', {
        p_server_id: serverId,
        p_user_id: ownerId,
      });

      // Kiểm tra broadcast server room
      expect(chatGatewayMock.server.to).toHaveBeenCalledWith(Room.server(serverId));
      expect(emitMock).toHaveBeenCalledWith('server:deleted', { serverId });

      // Kiểm tra broadcast user rooms
      for (const mId of memberIds) {
        expect(chatGatewayMock.server.to).toHaveBeenCalledWith(Room.user(mId));
      }
    });

    it('should throw ForbiddenException if user is not owner (code 42501)', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: { code: '42501', message: 'Chỉ chủ sở hữu máy chủ mới có quyền xóa máy chủ' },
      });

      await expect(service.deleteServer('usr-member', 'srv-100')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException if server does not exist (code P0002)', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: { code: 'P0002', message: 'Máy chủ không tồn tại' },
      });

      await expect(service.deleteServer('usr-owner', 'srv-nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('leaveServer', () => {
    it('should successfully leave server via RPC and broadcast member-left', async () => {
      const serverId = 'srv-100';
      const userId = 'usr-member';

      supabaseService.client.rpc.mockResolvedValue({
        data: {
          success: true,
          alreadyLeft: false,
          serverId,
        },
        error: null,
      });

      const result = await service.leaveServer(userId, serverId);

      expect(result).toEqual({ success: true, serverId, alreadyLeft: false });
      expect(supabaseService.client.rpc).toHaveBeenCalledWith('leave_server', {
        p_server_id: serverId,
        p_user_id: userId,
      });

      expect(chatGatewayMock.server.to).toHaveBeenCalledWith(Room.server(serverId));
      expect(chatGatewayMock.server.to).toHaveBeenCalledWith(Room.user(userId));
      expect(emitMock).toHaveBeenCalledWith('server:member-left', { serverId, userId });
    });

    it('should return alreadyLeft: true without re-broadcasting if already left (idempotent)', async () => {
      const serverId = 'srv-100';
      const userId = 'usr-member';

      supabaseService.client.rpc.mockResolvedValue({
        data: {
          success: true,
          alreadyLeft: true,
          serverId,
        },
        error: null,
      });

      const result = await service.leaveServer(userId, serverId);

      expect(result).toEqual({ success: true, serverId, alreadyLeft: true });
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('should throw ConflictException if owner attempts to leave server', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: {
          success: false,
          reason: 'owner_cannot_leave',
          message: 'Chủ sở hữu không thể rời máy chủ. Vui lòng chuyển quyền sở hữu hoặc xóa máy chủ.',
        },
        error: null,
      });

      await expect(service.leaveServer('usr-owner', 'srv-100')).rejects.toThrow(ConflictException);
    });
  });
});


