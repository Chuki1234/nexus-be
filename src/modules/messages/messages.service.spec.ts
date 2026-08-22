import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from '../conversations/conversations.service';
import { MessagesService } from './messages.service';

describe('MessagesService', () => {
  let service: MessagesService;
  let mockSupabase: { client: { from: jest.Mock } };
  let mockConversationsService: { verifyMembership: jest.Mock };

  beforeEach(async () => {
    mockSupabase = {
      client: {
        from: jest.fn(),
      },
    };

    mockConversationsService = {
      verifyMembership: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: ConversationsService, useValue: mockConversationsService },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  describe('getConversationMessages', () => {
    it('chặn nếu không phải thành viên conversation (403)', async () => {
      mockConversationsService.verifyMembership.mockResolvedValueOnce(false);

      await expect(
        service.getConversationMessages('user-1', 'conv-1', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('tải danh sách tin nhắn và trả về đúng định dạng', async () => {
      const mockRawMessages = [
        {
          id: 102,
          channel_id: null,
          conversation_id: 'conv-1',
          author_id: 'user-1',
          type: 'default',
          content: 'Hello World',
          reply_to_id: null,
          client_nonce: 'nonce-1',
          edited_at: null,
          deleted_at: null,
          created_at: '2026-08-22T10:00:00Z',
        },
      ];

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue({
              data: mockRawMessages,
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'user-1',
                  username: 'user1',
                  display_name: 'User One',
                  avatar_url: null,
                },
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.getConversationMessages('user-1', 'conv-1', {
        limit: 50,
      });
      expect(res.messages.length).toBe(1);
      expect(res.messages[0].id).toBe('102');
      expect(res.messages[0].content).toBe('Hello World');
      expect(res.messages[0].author?.displayName).toBe('User One');
      expect(res.hasMore).toBe(false);
    });
  });

  describe('createConversationMessage', () => {
    it('chặn tin nhắn rỗng (400)', async () => {
      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('trả về tin nhắn đã có nếu clientNonce trùng (idempotency)', async () => {
      const mockExisting = {
        id: 99,
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Tin đã gửi',
        reply_to_id: null,
        client_nonce: 'nonce-123',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T09:00:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: mockExisting,
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'user1',
                display_name: 'User One',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.createConversationMessage('user-1', 'conv-1', {
        content: 'Tin đã gửi',
        clientNonce: 'nonce-123',
      });
      expect(res.id).toBe('99');
      expect(res.content).toBe('Tin đã gửi');
    });

    it('chèn tin nhắn mới và trả về đầy đủ thông tin', async () => {
      const mockCreated = {
        id: 105,
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Tin nhắn mới',
        reply_to_id: null,
        client_nonce: 'nonce-456',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:05:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: null,
              error: null,
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
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'user1',
                display_name: 'User One',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.createConversationMessage('user-1', 'conv-1', {
        content: 'Tin nhắn mới',
        clientNonce: 'nonce-456',
      });
      expect(res.id).toBe('105');
      expect(res.content).toBe('Tin nhắn mới');
      expect(res.author?.username).toBe('user1');
    });
  });

  describe('editMessage', () => {
    it('chặn chỉnh sửa tin nhắn của người khác (403)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 101,
                author_id: 'user-other',
                deleted_at: null,
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(
        service.editMessage('user-1', '101', { content: 'Sửa nè' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deleteMessage', () => {
    it('chặn xoá tin nhắn của người khác (403)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 101,
                author_id: 'user-other',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.deleteMessage('user-1', '101')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('soft delete tin nhắn thành công', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 101,
                conversation_id: 'conv-1',
                author_id: 'user-1',
              },
              error: null,
            }),
            update: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        return {};
      });

      const res = await service.deleteMessage('user-1', '101');
      expect(res.deleted).toBe(true);
      expect(res.id).toBe('101');
    });
  });
});
