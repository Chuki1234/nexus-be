import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

describe('ConversationsController', () => {
  let controller: ConversationsController;
  let service: ConversationsService;

  const mockUser: User = {
    id: 'user-123',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-08-22T00:00:00Z',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConversationsController],
      providers: [
        {
          provide: ConversationsService,
          useValue: {
            getOrCreateDm: jest.fn().mockResolvedValue({ id: 'conv-1', type: 'dm' }),
            listConversations: jest.fn().mockResolvedValue([{ id: 'conv-1', type: 'dm' }]),
            getConversationById: jest.fn().mockResolvedValue({ id: 'conv-1', type: 'dm' }),
          },
        },
        {
          provide: SupabaseService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<ConversationsController>(ConversationsController);
    service = module.get<ConversationsService>(ConversationsService);
  });

  it('gọi service.getOrCreateDm khi POST /api/conversations/dm', async () => {
    const res = await controller.getOrCreateDm(mockUser, { recipientId: 'user-456' });
    expect(service.getOrCreateDm).toHaveBeenCalledWith('user-123', 'user-456');
    expect(res.id).toBe('conv-1');
  });

  it('gọi service.listConversations khi GET /api/conversations', async () => {
    const res = await controller.listConversations(mockUser);
    expect(service.listConversations).toHaveBeenCalledWith('user-123');
    expect(res.length).toBe(1);
  });

  it('gọi service.getConversationById khi GET /api/conversations/:id', async () => {
    const res = await controller.getConversation(mockUser, 'conv-1');
    expect(service.getConversationById).toHaveBeenCalledWith('user-123', 'conv-1');
    expect(res.id).toBe('conv-1');
  });
});
