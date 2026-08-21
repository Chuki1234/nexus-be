import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { SERVER_TEMPLATES } from './constants/server-templates.constant';
import { CreateServerDto } from './dto/create-server.dto';
import {
  ServersController,
  ServerTemplatesController,
} from './servers.controller';
import { ServersService } from './servers.service';

describe('ServersController', () => {
  let controller: ServersController;
  let templatesController: ServerTemplatesController;
  let serversService: jest.Mocked<ServersService>;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
  } as User;

  beforeEach(async () => {
    const mockServersService = {
      getTemplates: jest.fn().mockReturnValue(SERVER_TEMPLATES),
      createServer: jest.fn(),
      listUserServers: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ServersController, ServerTemplatesController],
      providers: [
        {
          provide: ServersService,
          useValue: mockServersService,
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ServersController>(ServersController);
    templatesController = module.get<ServerTemplatesController>(
      ServerTemplatesController,
    );
    serversService = module.get(ServersService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
    expect(templatesController).toBeDefined();
  });

  describe('getTemplates', () => {
    it('should return server templates list', () => {
      const result = controller.getTemplates();
      expect(result).toBe(SERVER_TEMPLATES);
      expect(templatesController.getTemplates()).toBe(SERVER_TEMPLATES);
    });
  });

  describe('createServer', () => {
    it('should call serversService.createServer with authenticated user id and dto with templateId', async () => {
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
        channels: [
          {
            id: 'chan-1',
            name: 'chào-mừng',
            type: 'text' as const,
            topic: null,
            unread: false,
            mentionCount: 0,
          },
          {
            id: 'chan-2',
            name: 'Phòng chờ',
            type: 'voice' as const,
            topic: null,
            unread: false,
            mentionCount: 0,
          },
        ],
      };

      serversService.createServer.mockResolvedValue(expectedResponse);

      const result = await controller.createServer(mockUser, dto);

      expect(serversService.createServer).toHaveBeenCalledWith('user-123', dto);
      expect(result).toEqual(expectedResponse);
    });
  });

  describe('listServers', () => {
    it('should call serversService.listUserServers with authenticated user id', async () => {
      const expectedServers = [
        {
          id: 'server-1',
          name: 'Máy chủ 1',
          iconUrl: null,
          unread: false,
          mentionCount: 0,
          channels: [
            {
              id: 'chan-1',
              name: 'chung',
              type: 'text' as const,
              topic: null,
              unread: false,
              mentionCount: 0,
            },
          ],
        },
      ];

      serversService.listUserServers.mockResolvedValue(expectedServers);

      const result = await controller.listServers(mockUser);

      expect(serversService.listUserServers).toHaveBeenCalledWith('user-123');
      expect(result).toEqual(expectedServers);
    });
  });
});
