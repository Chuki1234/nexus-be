import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
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

    it('chặn tạo DM nếu hai người chưa là bạn bè (403)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      });

      await expect(
        service.getOrCreateDm('user-1', 'user-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('trả về cuộc trò chuyện hiện có nếu đã tồn tại', async () => {
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
            insert: jest.fn().mockResolvedValue({ error: null }),
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
