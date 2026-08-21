import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { SERVER_TEMPLATES } from './constants/server-templates.constant';
import { CreateServerDto } from './dto/create-server.dto';
import { ServersService } from './servers.service';

describe('ServersService', () => {
  let service: ServersService;
  let supabaseService: { client: any };

  beforeEach(async () => {
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
    it('should create a channel successfully if user is a server member', async () => {
      const dto = {
        name: 'thảo-luận-mới',
        type: 'text' as const,
        topic: 'Thảo luận các chủ đề mới',
      };

      const mockMembership = { server_id: 'server-1' };
      const mockMaxPos = [{ position: 2 }];
      const mockCreated = {
        id: 'c-new-1',
        name: 'thảo-luận-mới',
        type: 'text',
        topic: 'Thảo luận các chủ đề mới',
        position: 3,
      };

      supabaseService.client.from.mockImplementation((table: string) => {
        if (table === 'server_members') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: mockMembership,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'channels') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: mockMaxPos,
                    error: null,
                  }),
                }),
              }),
            }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: mockCreated,
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const result = await service.createChannel('user-1', 'server-1', dto);

      expect(result).toEqual({
        id: 'c-new-1',
        name: 'thảo-luận-mới',
        type: 'text',
        topic: 'Thảo luận các chủ đề mới',
        unread: false,
        mentionCount: 0,
      });
    });

    it('should throw ForbiddenException if user is not in server_members', async () => {
      const dto = {
        name: 'kenh-cam',
        type: 'text' as const,
      };

      supabaseService.client.from.mockImplementation((table: string) => {
        if (table === 'server_members') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: null,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
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

    it('should throw BadRequestException if channel type is invalid', async () => {
      await expect(
        service.createChannel('user-1', 'server-1', {
          name: 'kenh-loi',
          type: 'invalid-type' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

