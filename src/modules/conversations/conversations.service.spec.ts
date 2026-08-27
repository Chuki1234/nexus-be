import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from './conversations.service';

describe('ConversationsService', () => {
  let service: ConversationsService;
  let mockSupabase: { client: { from: jest.Mock; rpc: jest.Mock } };

  beforeEach(async () => {
    mockSupabase = {
      client: {
        from: jest.fn(),
        rpc: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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

    it('gọi đúng RPC get_or_create_dm_conversation với tham số p_user_id và p_recipient_id', async () => {
      const mockConv = {
        id: 'conv-123',
        type: 'dm',
        name: null,
        icon_url: null,
        owner_id: 'user-1',
        dm_key: 'user-1:user-2',
        created_at: '2026-08-22T00:00:00Z',
      };

      mockSupabase.client.rpc.mockResolvedValue({
        data: mockConv,
        error: null,
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-2',
                username: 'user2',
                display_name: 'User Hai',
                avatar_url: null,
                status_message: null,
                manual_presence: 'online',
              },
              error: null,
            }),
          };
        }
        // Fallback chainable cho friendships/messages/conversation_participants —
        // getOrCreateDm giờ tra bạn bè + đặt trạng thái duyệt; test này không quan
        // tâm các bảng đó nên trả rỗng.
        const chain: any = {
          select: jest.fn(() => chain),
          eq: jest.fn(() => chain),
          or: jest.fn(() => chain),
          in: jest.fn(() => chain),
          update: jest.fn(() => chain),
          limit: jest.fn().mockResolvedValue({ data: [], error: null }),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          then: (resolve: any) => resolve({ data: [], count: 0, error: null }),
        };
        return chain;
      });

      const res = await service.getOrCreateDm('user-1', 'user-2');

      expect(mockSupabase.client.rpc).toHaveBeenCalledWith(
        'get_or_create_dm_conversation',
        {
          p_user_id: 'user-1',
          p_recipient_id: 'user-2',
        },
      );
      expect(res.id).toBe('conv-123');
      expect(res.type).toBe('dm');
      expect(res.recipient?.username).toBe('user2');
      expect(res.recipient?.displayName).toBe('User Hai');
    });

    it('ném ForbiddenException khi RPC trả lỗi 42501 do quan hệ chặn', async () => {
      mockSupabase.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '42501',
          message: 'Không thể nhắn tin trực tiếp với người dùng này do có quan hệ chặn.',
        },
      });

      await expect(
        service.getOrCreateDm('user-1', 'user-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('ném NotFoundException khi RPC trả lỗi P0002 do người nhận không tồn tại', async () => {
      mockSupabase.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: 'P0002',
          message: 'Không tìm thấy người dùng nhận.',
        },
      });

      await expect(
        service.getOrCreateDm('user-1', 'nonexistent-user'),
      ).rejects.toThrow(NotFoundException);
    });

    it('ném InternalServerErrorException khi RPC trả lỗi không mong đợi khác', async () => {
      mockSupabase.client.rpc.mockResolvedValue({
        data: null,
        error: {
          code: '50000',
          message: 'Database connection failure',
        },
      });

      await expect(
        service.getOrCreateDm('user-1', 'user-2'),
      ).rejects.toThrow(InternalServerErrorException);
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
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            or: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                {
                  user_a_id: 'user-1',
                  user_b_id: 'user-2',
                  status: 'accepted',
                },
              ],
              error: null,
            }),
          };
        }
        return {
          delete: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ error: null }),
        };
      });

      const res = await service.listConversations('user-1');
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('conv-10');
      expect(res[0].recipient?.username).toBe('alice');
      expect(res[0].recipient?.displayName).toBe('Alice Wonder');
      expect(res[0].unreadCount).toBe(2);
    });

    it('GIỮ DM người-lạ (chưa kết bạn) và gắn cờ isFriend=false thay vì lọc bỏ', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'conversation_participants') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [{ conversation_id: 'conv-orphan' }],
              error: null,
            }),
            in: jest.fn().mockResolvedValue({
              data: [
                { conversation_id: 'conv-orphan', user_id: 'user-1' },
                { conversation_id: 'conv-orphan', user_id: 'stranger-99' },
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
                  id: 'conv-orphan',
                  type: 'dm',
                  name: null,
                  icon_url: null,
                  owner_id: 'user-1',
                  created_at: '2026-08-01T00:00:00Z',
                },
              ],
              error: null,
            }),
            delete: jest.fn().mockReturnValue({
              in: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'stranger-99',
                  username: 'stranger',
                  display_name: 'Stranger',
                  avatar_url: null,
                  status_message: null,
                  manual_presence: 'offline',
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
              data: [],
              error: null,
            }),
          };
        }
        if (table === 'friendships') {
          return {
            select: jest.fn().mockReturnThis(),
            or: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [], // Không có ai trong danh sách bạn bè
              error: null,
            }),
          };
        }
        return {
          delete: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ error: null }),
        };
      });

      const res = await service.listConversations('user-1');
      // Trước đây DM người-lạ bị lọc bỏ; nay giữ lại để hiện ở "Người lạ"/DM.
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('conv-orphan');
      expect(res[0].isFriend).toBe(false);
      expect(res[0].recipient?.username).toBe('stranger');
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
