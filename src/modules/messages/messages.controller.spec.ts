import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

describe('MessagesController', () => {
  let controller: MessagesController;
  let service: MessagesService;

  const mockUser: User = {
    id: 'user-123',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-08-22T00:00:00Z',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [
        {
          provide: MessagesService,
          useValue: {
            getConversationMessages: jest
              .fn()
              .mockResolvedValue({ messages: [], hasMore: false }),
            createConversationMessage: jest
              .fn()
              .mockResolvedValue({ id: 'msg-1', content: 'hello' }),
            editMessage: jest
              .fn()
              .mockResolvedValue({ id: 'msg-1', content: 'edited' }),
            deleteMessage: jest
              .fn()
              .mockResolvedValue({ id: 'msg-1', deleted: true }),
            markAsRead: jest.fn().mockResolvedValue({ success: true }),
          },
        },
        {
          provide: SupabaseService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<MessagesController>(MessagesController);
    service = module.get<MessagesService>(MessagesService);
  });

  it('gọi service.getConversationMessages khi GET /api/conversations/:id/messages', async () => {
    const res = await controller.getConversationMessages(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      { limit: 20 },
    );
    expect(service.getConversationMessages).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      { limit: 20 },
    );
    expect(res.messages).toEqual([]);
  });

  it('gọi service.createConversationMessage khi POST /api/conversations/:id/messages', async () => {
    const res = await controller.sendConversationMessage(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      { content: 'hello' },
    );
    expect(service.createConversationMessage).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      { content: 'hello' },
    );
    expect(res.id).toBe('msg-1');
  });

  it('gọi service.editMessage khi PATCH /api/messages/:id', async () => {
    const res = await controller.editMessage(mockUser, '101', {
      content: 'edited',
    });
    expect(service.editMessage).toHaveBeenCalledWith('user-123', '101', {
      content: 'edited',
    });
    expect(res.content).toBe('edited');
  });

  it('gọi service.deleteMessage khi DELETE /api/messages/:id', async () => {
    const res = await controller.deleteMessage(mockUser, '101');
    expect(service.deleteMessage).toHaveBeenCalledWith('user-123', '101');
    expect(res.deleted).toBe(true);
  });

  it('gọi service.markAsRead khi POST /api/conversations/:id/read', async () => {
    const res = await controller.markAsRead(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      '101',
    );
    expect(service.markAsRead).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      '101',
    );
    expect(res.success).toBe(true);
  });
});
