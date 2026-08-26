import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { DeleteMessageScope } from './dto/delete-message.dto';

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
              .mockResolvedValue({ id: 'msg-1', deleted: true, scope: 'for_me' }),
            hideMessageForUser: jest
              .fn()
              .mockResolvedValue({ id: 'msg-1', hidden: true, scope: 'for_me' }),
            recallMessageForEveryone: jest
              .fn()
              .mockResolvedValue({ id: 'msg-1', deleted: true, scope: 'everyone' }),
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
      {},
    );
    expect(service.getConversationMessages).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      {},
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
      undefined,
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

  it('gọi service.hideMessageForUser khi POST /api/messages/:id/hide', async () => {
    const res = await controller.hideMessage(mockUser, '101');
    expect(service.hideMessageForUser).toHaveBeenCalledWith('user-123', '101');
    expect(res.hidden).toBe(true);
  });

  it('gọi service.recallMessageForEveryone khi POST /api/messages/:id/recall', async () => {
    const res = await controller.recallMessage(mockUser, '101');
    expect(service.recallMessageForEveryone).toHaveBeenCalledWith('user-123', '101');
    expect(res.deleted).toBe(true);
  });

  it('gọi service.deleteMessage khi DELETE /api/messages/:id', async () => {
    const res = await controller.deleteMessage(mockUser, '101', { scope: DeleteMessageScope.EVERYONE });
    expect(service.deleteMessage).toHaveBeenCalledWith('user-123', '101', 'everyone');
    expect(res.deleted).toBe(true);
  });

  it('gọi service.markAsRead khi POST /api/conversations/:id/read', async () => {
    const res = await controller.markAsRead(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      { messageId: '101' },
    );
    expect(service.markAsRead).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      '101',
    );
    expect(res.success).toBe(true);
  });

  it('gọi service.getAttachmentSignedUrl khi GET /api/conversations/:id/attachments/:attId/signed-url', async () => {
    (service as unknown as { getAttachmentSignedUrl: jest.Mock }).getAttachmentSignedUrl = jest
      .fn()
      .mockResolvedValue({ signedUrl: 'https://storage.supabase.co/signed/file.png' });

    const res = await controller.getAttachmentSignedUrl(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
    );
    expect(
      (service as unknown as { getAttachmentSignedUrl: jest.Mock }).getAttachmentSignedUrl,
    ).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
    );
    expect(res.signedUrl).toBe('https://storage.supabase.co/signed/file.png');
  });

  it('gọi service.forwardConversationMessage khi POST /api/conversations/:id/messages/:msgId/forward', async () => {
    (service as unknown as { forwardConversationMessage: jest.Mock }).forwardConversationMessage = jest
      .fn()
      .mockResolvedValue({
        id: '202',
        conversationId: 'c0000000-0000-0000-0000-000000000003',
        content: 'Forwarded msg',
        isForwarded: true,
      });

    const res = await controller.forwardConversationMessage(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      '101',
      {
        targetConversationId: 'c0000000-0000-0000-0000-000000000003',
        clientNonce: 'd0000000-0000-0000-0000-000000000004',
      },
    );

    expect(
      (service as unknown as { forwardConversationMessage: jest.Mock }).forwardConversationMessage,
    ).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      '101',
      {
        targetConversationId: 'c0000000-0000-0000-0000-000000000003',
        clientNonce: 'd0000000-0000-0000-0000-000000000004',
      },
    );
    expect(res.isForwarded).toBe(true);
  });

  it('gọi service.setReaction khi POST /api/conversations/:id/messages/:msgId/reactions', async () => {
    (service as unknown as { setReaction: jest.Mock }).setReaction = jest
      .fn()
      .mockResolvedValue({
        messageId: '101',
        conversationId: 'a0000000-0000-0000-0000-000000000001',
        reactions: [{ emoji: '🔥', count: 1, reactedByMe: true }],
      });

    const res = await controller.setReaction(
      mockUser,
      'a0000000-0000-0000-0000-000000000001',
      '101',
      { emoji: '🔥', reacted: true },
    );

    expect(
      (service as unknown as { setReaction: jest.Mock }).setReaction,
    ).toHaveBeenCalledWith(
      'user-123',
      'a0000000-0000-0000-0000-000000000001',
      '101',
      { emoji: '🔥', reacted: true },
    );
    expect(res.reactions).toHaveLength(1);
  });
});
