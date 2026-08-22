import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { Room } from '../../shared/socket-events';
import { ConversationsService } from '../conversations/conversations.service';
import { ChatGateway, TypedSocket } from './chat.gateway';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let supabaseMock: any;
  let conversationsServiceMock: any;
  let serverMock: any;

  const validUuid = '11111111-1111-4111-a111-111111111111';

  beforeEach(async () => {
    supabaseMock = {
      client: {
        auth: {
          getUser: jest.fn(),
        },
      },
    };

    conversationsServiceMock = {
      verifyMembership: jest.fn(),
    };

    serverMock = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: SupabaseService, useValue: supabaseMock },
        { provide: ConversationsService, useValue: conversationsServiceMock },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
    gateway.server = serverMock;
  });

  describe('handleConnection', () => {
    it('ngắt kết nối nếu không có token trong auth hoặc authorization header', async () => {
      const client = {
        id: 'sock-1',
        handshake: { auth: {}, headers: {} },
        data: {},
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as TypedSocket;

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('từ chối và ngắt kết nối nếu token chỉ gửi qua query string', async () => {
      const client = {
        id: 'sock-query',
        handshake: {
          auth: {},
          headers: {},
          query: { token: 'token-in-query' },
        },
        data: {},
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as TypedSocket;

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('ngắt kết nối nếu token không hợp lệ theo Supabase Auth', async () => {
      const client = {
        id: 'sock-2',
        handshake: { auth: { token: 'invalid-token' }, headers: {} },
        data: {},
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as TypedSocket;

      supabaseMock.client.auth.getUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'JWT expired' },
      });

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('xác thực thành công qua Bearer header, lưu userId và join user room', async () => {
      const client = {
        id: 'sock-3',
        handshake: {
          auth: {},
          headers: { authorization: 'Bearer valid-jwt-token' },
        },
        data: {} as { userId?: string },
        disconnect: jest.fn(),
        join: jest.fn(),
      } as unknown as TypedSocket;

      supabaseMock.client.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null,
      });

      await gateway.handleConnection(client);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.userId).toBe('user-123');
      expect(client.join).toHaveBeenCalledWith(Room.user('user-123'));
    });
  });

  describe('conversation:join & conversation:leave', () => {
    it('từ chối join nếu conversationId không phải UUID', async () => {
      const client = {
        id: 'sock-invalid-uuid',
        data: { userId: 'user-123' },
        join: jest.fn(),
      } as unknown as TypedSocket;

      const result = await gateway.handleConversationJoin(client, {
        conversationId: 'not-a-uuid',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('UUID');
      expect(client.join).not.toHaveBeenCalled();
    });

    it('từ chối join conversation nếu user không phải participant', async () => {
      const client = {
        id: 'sock-4',
        data: { userId: 'user-123' },
        join: jest.fn(),
      } as unknown as TypedSocket;

      conversationsServiceMock.verifyMembership.mockResolvedValue(false);

      const result = await gateway.handleConversationJoin(client, {
        conversationId: validUuid,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Không có quyền');
      expect(client.join).not.toHaveBeenCalled();
    });

    it('cho phép join conversation nếu user là participant và ID là UUID hợp lệ', async () => {
      const client = {
        id: 'sock-5',
        data: { userId: 'user-123' },
        join: jest.fn(),
      } as unknown as TypedSocket;

      conversationsServiceMock.verifyMembership.mockResolvedValue(true);

      const result = await gateway.handleConversationJoin(client, {
        conversationId: validUuid,
      });

      expect(result.success).toBe(true);
      expect(client.join).toHaveBeenCalledWith(Room.conversation(validUuid));
    });

    it('leave conversation thành công', async () => {
      const client = {
        id: 'sock-6',
        data: { userId: 'user-123' },
        leave: jest.fn(),
      } as unknown as TypedSocket;

      const result = await gateway.handleConversationLeave(client, {
        conversationId: validUuid,
      });

      expect(result.success).toBe(true);
      expect(client.leave).toHaveBeenCalledWith(Room.conversation(validUuid));
    });
  });

  describe('typing:start & typing:stop & security', () => {
    it('không tạo typing state hoặc broadcast nếu user không thuộc conversation', async () => {
      const client = {
        id: 'sock-non-member',
        data: { userId: 'user-intruder' },
      } as unknown as TypedSocket;

      conversationsServiceMock.verifyMembership.mockResolvedValue(false);

      await gateway.handleTypingStart(client, { conversationId: validUuid });

      expect(serverMock.to).not.toHaveBeenCalled();
      expect(serverMock.emit).not.toHaveBeenCalled();
    });

    it('broadcast typing:updated khi user bắt đầu gõ và xóa khi stop', async () => {
      const client = {
        id: 'sock-7',
        data: { userId: 'user-123' },
      } as unknown as TypedSocket;

      conversationsServiceMock.verifyMembership.mockResolvedValue(true);

      await gateway.handleTypingStart(client, { conversationId: validUuid });

      expect(serverMock.to).toHaveBeenCalledWith(Room.conversation(validUuid));
      expect(serverMock.emit).toHaveBeenCalledWith('typing:updated', {
        conversationId: validUuid,
        userIds: ['user-123'],
      });

      // Khi ngừng gõ
      gateway.handleTypingStop(client, { conversationId: validUuid });

      expect(serverMock.emit).toHaveBeenCalledWith('typing:updated', {
        conversationId: validUuid,
        userIds: [],
      });
    });

    it('tự động cleanup typing state khi disconnect', async () => {
      const client = {
        id: 'sock-disc',
        data: { userId: 'user-456' },
      } as unknown as TypedSocket;

      conversationsServiceMock.verifyMembership.mockResolvedValue(true);

      await gateway.handleTypingStart(client, { conversationId: validUuid });

      // Disconnect
      gateway.handleDisconnect(client);

      expect(serverMock.emit).toHaveBeenLastCalledWith('typing:updated', {
        conversationId: validUuid,
        userIds: [],
      });
    });
  });

  describe('Domain Events Broadcast', () => {
    it('broadcast duy nhất message:created (không phát alias cũ message:new)', () => {
      const message = {
        id: '1001',
        conversationId: validUuid,
        channelId: null,
        authorId: 'user-123',
        type: 'default' as const,
        content: 'Hello World',
        replyToId: null,
        clientNonce: 'nonce-1',
        editedAt: null,
        deletedAt: null,
        createdAt: '2026-08-22T10:00:00Z',
      };

      gateway.handleMessageCreated({
        conversationId: validUuid,
        channelId: null,
        message,
      });

      expect(serverMock.to).toHaveBeenCalledWith(Room.conversation(validUuid));
      expect(serverMock.emit).toHaveBeenCalledWith('message:created', {
        message,
      });
      expect(serverMock.emit).not.toHaveBeenCalledWith('message:new', expect.anything());
    });

    it('broadcast message:updated tới conversation room', () => {
      const message = {
        id: '1001',
        conversationId: validUuid,
        channelId: null,
        authorId: 'user-123',
        type: 'default' as const,
        content: 'Edited Message',
        replyToId: null,
        clientNonce: 'nonce-1',
        editedAt: '2026-08-22T10:05:00Z',
        deletedAt: null,
        createdAt: '2026-08-22T10:00:00Z',
      };

      gateway.handleMessageUpdated({
        conversationId: validUuid,
        channelId: null,
        message,
      });

      expect(serverMock.to).toHaveBeenCalledWith(Room.conversation(validUuid));
      expect(serverMock.emit).toHaveBeenCalledWith('message:updated', {
        message,
      });
    });

    it('broadcast message:deleted tới conversation room', () => {
      gateway.handleMessageDeleted({
        conversationId: validUuid,
        channelId: null,
        messageId: '1001',
      });

      expect(serverMock.to).toHaveBeenCalledWith(Room.conversation(validUuid));
      expect(serverMock.emit).toHaveBeenCalledWith('message:deleted', {
        channelId: null,
        conversationId: validUuid,
        messageId: '1001',
      });
    });

    it('broadcast message:read tới conversation room', () => {
      gateway.handleMessageRead({
        conversationId: validUuid,
        userId: 'user-123',
        lastReadMessageId: '1001',
      });

      expect(serverMock.to).toHaveBeenCalledWith(Room.conversation(validUuid));
      expect(serverMock.emit).toHaveBeenCalledWith('message:read', {
        conversationId: validUuid,
        userId: 'user-123',
        lastReadMessageId: '1001',
      });
    });
  });
});
