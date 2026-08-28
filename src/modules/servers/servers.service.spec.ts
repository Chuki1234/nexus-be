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
import { ServerPermissionsService } from './server-permissions.service';
import { MediaService } from '../../infra/storage/media.service';

describe('ServersService', () => {
  let service: ServersService;
  let supabaseService: { client: any };
  let chatGatewayMock: {
    server: { to: jest.Mock };
    emitChannelsInvalidated: jest.Mock;
  };
  let emitMock: jest.Mock;

  beforeEach(async () => {
    emitMock = jest.fn();
    chatGatewayMock = {
      server: {
        to: jest.fn().mockReturnValue({
          emit: emitMock,
        }),
      },
      emitChannelsInvalidated: jest.fn(),
      emitServerMemberLeft: jest.fn((serverId: string, userId: string) => {
        chatGatewayMock.server.to(Room.server(serverId)).emit('server:member-left', { serverId, userId });
        chatGatewayMock.server.to(Room.user(userId)).emit('server:deleted', { serverId });
      }),
      emitServerMemberKicked: jest.fn((serverId: string, userId: string, kickedBy: string) => {
        chatGatewayMock.server.to(Room.server(serverId)).emit('server:member-kicked', { serverId, userId, kickedBy });
        chatGatewayMock.server.to(Room.user(userId)).emit('server:deleted', { serverId });
      }),
      emitServerMemberBanned: jest.fn((serverId: string, userId: string, bannedBy: string, reason?: string) => {
        chatGatewayMock.server.to(Room.server(serverId)).emit('server:member-banned', { serverId, userId, bannedBy, reason });
        chatGatewayMock.server.to(Room.user(userId)).emit('server:deleted', { serverId });
      }),
      emitServerMemberUnbanned: jest.fn((serverId: string, userId: string) => {
        chatGatewayMock.server.to(Room.server(serverId)).emit('server:member-unbanned', { serverId, userId });
      }),
    } as any;

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
        {
          provide: ServerPermissionsService,
          useValue: {
            getCapabilities: jest
              .fn()
              .mockResolvedValue({ canManageChannels: true }),
            getChannelPermissions: jest.fn().mockResolvedValue(~0n),
            assertChannelView: jest.fn().mockResolvedValue(undefined),
            assertChannelSend: jest.fn().mockResolvedValue(undefined),
            assertChannelAttach: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: MediaService,
          useValue: {
            uploadServerIcon: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ServersService>(ServersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('channel structure validation', () => {
    it('accepts a two-level layout containing every server channel exactly once', () => {
      const result = (service as any).validateAndNormalizeChannelStructure(
        {
          version: 1,
          categories: [{ id: 'cat-main', name: 'Chính' }],
          rootItems: [
            { kind: 'category', id: 'cat-main' },
            { kind: 'channel', id: 'channel-root' },
          ],
          categoryChannels: { 'cat-main': ['channel-child'] },
        },
        new Set(['channel-root', 'channel-child']),
      );

      expect(result.categoryChannels['cat-main']).toEqual(['channel-child']);
    });

    it('rejects a layout that duplicates or omits a server channel', () => {
      expect(() =>
        (service as any).validateAndNormalizeChannelStructure(
          {
            version: 1,
            categories: [{ id: 'cat-main', name: 'Chính' }],
            rootItems: [
              { kind: 'category', id: 'cat-main' },
              { kind: 'channel', id: 'channel-1' },
            ],
            categoryChannels: { 'cat-main': ['channel-1'] },
          },
          new Set(['channel-1', 'channel-2']),
        ),
      ).toThrow(BadRequestException);
    });
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
          systemChannelId: null,
          channelStructure: null,
          channels: [
            {
              id: 'c-1',
              name: 'chào-mừng',
              type: 'text',
              topic: null,
              position: 0,
              unread: false,
              mentionCount: 0,
            },
            {
              id: 'c-2',
              name: 'Phòng chờ',
              type: 'voice',
              topic: null,
              position: 1,
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

      expect(supabaseService.client.rpc).toHaveBeenCalledWith(
        'create_server_channel',
        {
          p_server_id: 'server-1',
          p_user_id: 'user-1',
          p_name: 'thảo-luận-mới',
          p_type: 'text',
          p_topic: 'Thảo luận các chủ đề mới',
        },
      );

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
        error: {
          code: '42501',
          message: 'Bạn không có quyền quản lý kênh trong máy chủ này',
        },
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
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
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
      expect(chatGatewayMock.server.to).toHaveBeenCalledWith(
        Room.server(serverId),
      );
      expect(emitMock).toHaveBeenCalledWith('server:deleted', { serverId });

      // Kiểm tra broadcast user rooms
      for (const mId of memberIds) {
        expect(chatGatewayMock.server.to).toHaveBeenCalledWith(Room.user(mId));
      }
    });

    it('should throw ForbiddenException if user is not owner (code 42501)', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '42501',
          message: 'Chỉ chủ sở hữu máy chủ mới có quyền xóa máy chủ',
        },
      });

      await expect(
        service.deleteServer('usr-member', 'srv-100'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if server does not exist (code P0002)', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: { code: 'P0002', message: 'Máy chủ không tồn tại' },
      });

      await expect(
        service.deleteServer('usr-owner', 'srv-nonexistent'),
      ).rejects.toThrow(NotFoundException);
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

      expect(chatGatewayMock.server.to).toHaveBeenCalledWith(
        Room.server(serverId),
      );
      expect(chatGatewayMock.server.to).toHaveBeenCalledWith(Room.user(userId));
      expect(emitMock).toHaveBeenCalledWith('server:member-left', {
        serverId,
        userId,
      });
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
          message:
            'Chủ sở hữu không thể rời máy chủ. Vui lòng chuyển quyền sở hữu hoặc xóa máy chủ.',
        },
        error: null,
      });

      await expect(service.leaveServer('usr-owner', 'srv-100')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('updateChannel & deleteChannel (Checkpoint 12 Blockers 3, 4)', () => {
    const serverId = 'srv-100';
    const channelId = 'chan-101';
    const userId = 'usr-admin';

    it('updateChannel updates channel name/topic and broadcasts server:channel-updated event', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: {
          id: channelId,
          serverId,
          name: 'general-chat',
          type: 'text',
          topic: 'New topic',
          position: 0,
        },
        error: null,
      });

      const res = await service.updateChannel(userId, serverId, channelId, {
        name: 'general-chat',
        topic: 'New topic',
      });

      expect(res.name).toBe('general-chat');
      expect(res.topic).toBe('New topic');
      expect(supabaseService.client.rpc).toHaveBeenCalledWith(
        'update_server_channel',
        {
          p_server_id: serverId,
          p_channel_id: channelId,
          p_user_id: userId,
          p_name: 'general-chat',
          p_topic: 'New topic',
        },
      );
      expect(emitMock).toHaveBeenCalledWith('server:channel-updated', {
        serverId,
        channel: res,
      });
    });

    it('updateChannel throws ForbiddenException when user lacks MANAGE_CHANNELS (code 42501)', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '42501',
          message: 'Bạn không có quyền quản lý kênh trong máy chủ này',
        },
      });

      await expect(
        service.updateChannel(userId, serverId, channelId, { name: 'hacked' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('deleteChannel successfully deletes non-last text channel and broadcasts event', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: {
          success: true,
          channelId,
          serverId,
        },
        error: null,
      });

      const res = await service.deleteChannel(userId, serverId, channelId);
      expect(res.success).toBe(true);
      expect(emitMock).toHaveBeenCalledWith('server:channel-deleted', {
        serverId,
        channelId,
      });
    });

    it('deleteChannel throws BadRequestException when attempting to delete the only text channel (code 22023)', async () => {
      supabaseService.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '22023',
          message: 'Không thể xóa kênh chữ duy nhất còn lại của máy chủ',
        },
      });

      await expect(
        service.deleteChannel(userId, serverId, channelId),
      ).rejects.toThrow(BadRequestException);
    });

    it('updateChannel: Deferred Barrier kiểm thử hai requests đồng thời tới RPC và emit events độc lập', async () => {
      let callOrder: string[] = [];
      let barrierReached = false;

      // Deferred Barrier đảm bảo cả 2 request đều được khởi tạo và chờ ở RPC
      let resolveProceed: () => void;
      const proceedPromise = new Promise<void>((resolve) => {
        resolveProceed = resolve;
      });

      let arrivedCount = 0;
      let resolveReached: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        resolveReached = resolve;
      });

      supabaseService.client.rpc.mockImplementation(
        async (rpcName: string, params: any) => {
          if (rpcName === 'update_server_channel') {
            callOrder.push(params.p_name);
            arrivedCount++;
            if (arrivedCount === 2) {
              resolveReached();
            }
            await proceedPromise;
            return {
              data: {
                id: channelId,
                serverId,
                name: params.p_name,
                type: 'text',
                topic: null,
                position: 0,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      );

      const p1 = service.updateChannel(userId, serverId, channelId, {
        name: 'chan-a',
      });
      const p2 = service.updateChannel(userId, serverId, channelId, {
        name: 'chan-b',
      });

      // Chờ cả 2 request cùng tới RPC barrier
      await reachedPromise;
      expect(callOrder).toHaveLength(2);

      // Giải phóng barrier
      resolveProceed!();

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1.name).toBe('chan-a');
      expect(res2.name).toBe('chan-b');
      expect(supabaseService.client.rpc).toHaveBeenCalledTimes(2);
      expect(chatGatewayMock.emitChannelsInvalidated).toHaveBeenCalledWith(
        serverId,
      );
      expect(chatGatewayMock.emitChannelsInvalidated).toHaveBeenCalledTimes(2);
    });
  });

  describe('kickServerMember', () => {
    it('thành công khi operator có quyền canKickMembers và target không phải Owner', async () => {
      const operatorId = 'op-1';
      const serverId = 'srv-1';
      const targetId = 'target-1';

      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canKickMembers: true,
      });

      supabaseService.client.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: { owner_id: 'owner-999' },
          error: null,
        }),
      });

      supabaseService.client.rpc.mockResolvedValue({
        data: { success: true },
        error: null,
      });

      const res = await service.kickServerMember(operatorId, serverId, targetId);
      expect(res).toEqual({
        success: true,
        serverId,
        targetUserId: targetId,
      });
      expect(supabaseService.client.rpc).toHaveBeenCalledWith('leave_server', {
        p_server_id: serverId,
        p_user_id: targetId,
      });
    });

    it('báo ForbiddenException khi operator không có quyền canKickMembers', async () => {
      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canKickMembers: false,
      });

      await expect(
        service.kickServerMember('user-no-perm', 'srv-1', 'target-1'),
      ).rejects.toThrow('Bạn không có quyền trục xuất thành viên khỏi máy chủ này.');
    });

    it('báo ForbiddenException khi cố gắng kick Owner của server', async () => {
      const ownerId = 'owner-123';
      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canKickMembers: true,
      });

      supabaseService.client.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: { owner_id: ownerId },
          error: null,
        }),
      });

      await expect(
        service.kickServerMember('operator-1', 'srv-1', ownerId),
      ).rejects.toThrow('Không thể trục xuất chủ sở hữu máy chủ.');
    });
  });

  describe('banServerMember & listServerBans', () => {
    it('thành công khi operator có quyền canBanMembers và ghi nhận ban', async () => {
      const serverId = 'srv-10';
      const operatorId = 'op-1';
      const targetId = 'target-2';
      const reason = 'Spam liên tục';

      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canBanMembers: true,
      });

      supabaseService.client.from.mockImplementation((table: string) => {
        if (table === 'servers') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { owner_id: 'owner-other' },
              error: null,
            }),
          };
        }
        if (table === 'server_bans') {
          return {
            upsert: jest.fn().mockResolvedValue({ error: null }),
          };
        }
        return {};
      });

      supabaseService.client.rpc.mockResolvedValue({
        data: { success: true },
        error: null,
      });

      const res = await service.banServerMember(operatorId, serverId, targetId, reason);

      expect(res).toEqual({
        success: true,
        serverId,
        targetUserId: targetId,
        reason,
      });
      expect(chatGatewayMock.emitServerMemberBanned).toHaveBeenCalledWith(
        serverId,
        targetId,
        operatorId,
        reason,
      );
    });

    it('báo ForbiddenException khi operator không có quyền canBanMembers', async () => {
      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canBanMembers: false,
      });

      await expect(
        service.banServerMember('user-no-perm', 'srv-1', 'target-1'),
      ).rejects.toThrow('Bạn không có quyền cấm thành viên khỏi máy chủ này.');
    });

    it('báo ForbiddenException khi cố gắng ban Owner của server', async () => {
      const ownerId = 'owner-99';
      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canBanMembers: true,
      });

      supabaseService.client.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: { owner_id: ownerId },
          error: null,
        }),
      });

      await expect(
        service.banServerMember('operator-1', 'srv-1', ownerId),
      ).rejects.toThrow('Không thể cấm chủ sở hữu máy chủ.');
    });

    it('thành công unbanServerMember khi operator có quyền canBanMembers', async () => {
      const serverId = 'srv-10';
      const operatorId = 'op-1';
      const targetId = 'target-2';

      jest.spyOn((service as any).serverPermissions, 'getCapabilities').mockResolvedValue({
        canBanMembers: true,
      });

      supabaseService.client.from.mockReturnValue({
        delete: jest.fn().mockReturnThis(),
        match: jest.fn().mockResolvedValue({ error: null }),
      });

      const res = await service.unbanServerMember(operatorId, serverId, targetId);

      expect(res).toEqual({
        success: true,
        serverId,
        targetUserId: targetId,
      });
      expect(chatGatewayMock.emitServerMemberUnbanned).toHaveBeenCalledWith(serverId, targetId);
    });
  });
});
