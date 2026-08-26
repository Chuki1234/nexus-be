import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from './conversations.service';

describe('ConversationsService', () => {
  let service: ConversationsService;
  let mockSupabase: { client: { from: jest.Mock } };

  beforeEach(async () => {
    mockSupabase = {
      client: {
        from: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: SupabaseService, useValue: mockSupabase },
      ],
    }).compile();

    service = module.get<ConversationsService>(ConversationsService);
  });

  describe('getOrCreateDm', () => {
    it('chặn tự tạo DM với chính mình (400)', async () => {
      await expect(
        service.getOrCreateDm('user-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('chặn tạo DM nếu hai người chặn nhau (403)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: { status: 'blocked' }, error: null }),
          };
        }
        return {};
      });

      await expect(
        service.getOrCreateDm('user-1', 'user-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('trả về cuộc trò chuyện hiện có và đảm bảo đủ 2 participants', async () => {
      const mockExistingConv = {
        id: 'conv-123',
        type: 'dm',
        name: null,
        icon_url: null,
        owner_id: 'user-1',
        dm_key: 'user-1:user-2',
        created_at: '2026-08-22T00:00:00Z',
      };

      const mockRecipientProfile = {
        id: 'user-2',
        username: 'user2',
        display_name: 'User Hai',
        avatar_url: null,
        status_message: null,
        manual_presence: 'online',
      };

      const upsertMock = jest.fn().mockResolvedValue({ error: null });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { status: 'accepted' },
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: mockExistingConv,
              error: null,
            }),
          };
        }
        if (table === 'conversation_participants') {
          return {
            upsert: upsertMock,
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: mockRecipientProfile,
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.getOrCreateDm('user-1', 'user-2');
      expect(res.id).toBe('conv-123');
      expect(res.type).toBe('dm');
      expect(res.recipient?.username).toBe('user2');
      expect(res.recipient?.displayName).toBe('User Hai');
      expect(upsertMock).toHaveBeenCalledWith(
        [
          { conversation_id: 'conv-123', user_id: 'user-1' },
          { conversation_id: 'conv-123', user_id: 'user-2' },
        ],
        { onConflict: 'conversation_id,user_id', ignoreDuplicates: true },
      );
    });

    it('tự động chữa lành khi conversation đã tồn tại nhưng thiếu participant (self-healing)', async () => {
      const mockOrphanConv = {
        id: 'conv-orphan',
        type: 'dm',
        name: null,
        icon_url: null,
        owner_id: 'user-1',
        dm_key: 'user-1:user-2',
        created_at: '2026-08-22T00:00:00Z',
      };

      const upsertMock = jest.fn().mockResolvedValue({ error: null });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { status: 'accepted' },
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: mockOrphanConv,
              error: null,
            }),
          };
        }
        if (table === 'conversation_participants') {
          return {
            upsert: upsertMock,
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-2',
                username: 'user2',
                display_name: 'User 2',
                avatar_url: null,
                status_message: null,
                manual_presence: 'online',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.getOrCreateDm('user-1', 'user-2');
      expect(res.id).toBe('conv-orphan');
      // Đảm bảo upsert được gọi để chữa lành 2 participant vào room
      expect(upsertMock).toHaveBeenCalledWith(
        [
          { conversation_id: 'conv-orphan', user_id: 'user-1' },
          { conversation_id: 'conv-orphan', user_id: 'user-2' },
        ],
        { onConflict: 'conversation_id,user_id', ignoreDuplicates: true },
      );
    });

    it('tạo mới cuộc trò chuyện và thêm participants nếu chưa tồn tại', async () => {
      const mockNewConv = {
        id: 'conv-new',
        type: 'dm',
        name: null,
        icon_url: null,
        owner_id: 'user-1',
        dm_key: 'user-1:user-2',
        created_at: '2026-08-22T00:00:00Z',
      };

      const upsertMock = jest.fn().mockResolvedValue({ error: null });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { status: 'accepted' },
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
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
                  data: mockNewConv,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'conversation_participants') {
          return {
            upsert: upsertMock,
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-2',
                username: 'user2',
                display_name: 'User 2',
                avatar_url: null,
                status_message: null,
                manual_presence: 'idle',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.getOrCreateDm('user-1', 'user-2');
      expect(res.id).toBe('conv-new');
      expect(res.recipient?.username).toBe('user2');
      expect(upsertMock).toHaveBeenCalled();
    });

    it('xử lý an toàn race condition khi hai user tạo đồng thời cùng 1 lúc', async () => {
      const mockRacedConv = {
        id: 'conv-raced',
        type: 'dm',
        name: null,
        icon_url: null,
        owner_id: 'user-2',
        dm_key: 'user-1:user-2',
        created_at: '2026-08-22T00:00:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { status: 'accepted' },
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
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
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                }),
              }),
            }),
            single: jest.fn().mockResolvedValue({
              data: mockRacedConv,
              error: null,
            }),
          };
        }
        if (table === 'conversation_participants') {
          return {
            upsert: jest.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-2',
                username: 'user2',
                display_name: 'User 2',
                avatar_url: null,
                status_message: null,
                manual_presence: 'online',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.getOrCreateDm('user-1', 'user-2');
      expect(res.id).toBe('conv-raced');
      expect(res.recipient?.username).toBe('user2');
    });
  });

  describe('listConversations', () => {
    it('trả về mảng rỗng nếu user chưa tham gia cuộc trò chuyện nào', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'conversation_participants') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      });

      const res = await service.listConversations('user-1');
      expect(res).toEqual([]);
    });

    it('truy vấn conversation_id và trả về đúng recipient cho DM', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'conversation_participants') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [{ conversation_id: 'conv-10' }],
              error: null,
            }),
            in: jest.fn().mockResolvedValue({
              data: [
                { conversation_id: 'conv-10', user_id: 'user-1' },
                { conversation_id: 'conv-10', user_id: 'user-2' },
              ],
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'conv-10',
                  type: 'dm',
                  name: null,
                  icon_url: null,
                  owner_id: 'user-1',
                  dm_key: 'user-1:user-2',
                  created_at: '2026-08-22T00:00:00Z',
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
              data: [
                {
                  id: 'user-2',
                  username: 'alice',
                  display_name: 'Alice Wonder',
                  avatar_url: null,
                  status_message: 'Hi',
                  manual_presence: 'online',
                },
              ],
              error: null,
            }),
          };
        }
        if (table === 'read_states') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [{ conversation_id: 'conv-10', mention_count: 2 }],
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await service.listConversations('user-1');
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('conv-10');
      expect(res[0].recipient?.username).toBe('alice');
      expect(res[0].recipient?.displayName).toBe('Alice Wonder');
      expect(res[0].unreadCount).toBe(2);
    });
  });

  describe('getConversationById', () => {
    it('ném lỗi 403 nếu user không phải thành viên', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'conversation_participants') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      });

      await expect(
        service.getConversationById('user-1', 'conv-999'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
