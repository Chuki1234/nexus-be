import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { Room } from '../../shared/socket-events';
import { ConversationsService } from '../conversations/conversations.service';
import { PresenceService } from './presence.service';
import { ChatGateway, TypedSocket } from './chat.gateway';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let supabaseMock: any;
  let conversationsServiceMock: any;
  let presenceServiceMock: any;
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
      getParticipantIds: jest.fn().mockResolvedValue(['user-123', 'user-456']),
    };

    presenceServiceMock = {
      handleUserConnect: jest.fn().mockResolvedValue({
        userId: 'user-123',
        isFirstConnection: true,
        status: 'online',
        peers: ['peer-bob', 'peer-charlie'],
      }),
      handleUserDisconnect: jest.fn(),
      getPeersSnapshot: jest.fn().mockResolvedValue({
        'peer-bob': { status: 'online', lastSeenAt: null },
        'peer-charlie': { status: 'offline', lastSeenAt: null },
      }),
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
        { provide: PresenceService, useValue: presenceServiceMock },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
    gateway.server = serverMock;
  });

  describe('afterInit & Namespace Middleware', () => {
    let middlewareFn: any;
    let mockNamespace: any;

    beforeEach(() => {
      mockNamespace = {
        use: jest.fn().mockImplementation((fn) => {
          middlewareFn = fn;
        }),
      };
      gateway.afterInit(mockNamespace);
    });

    it('đăng ký namespace middleware thành công', () => {
      expect(mockNamespace.use).toHaveBeenCalledWith(expect.any(Function));
      expect(middlewareFn).toBeDefined();
    });

    it('middleware từ chối với Error("Chưa xác thực") nếu thiếu token', async () => {
      const socket = {
        id: 'sock-no-token',
        handshake: { auth: {}, headers: {} },
        data: {},
      };
      const next = jest.fn();

      await middlewareFn(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('Chưa xác thực');
      expect((socket.data as any).userId).toBeUndefined();
    });

    it('middleware từ chối với Error("Chưa xác thực") nếu token không hợp lệ / hết hạn', async () => {
      const socket = {
        id: 'sock-invalid-token',
        handshake: { auth: { token: 'bad-token' }, headers: {} },
        data: {},
      };
      const next = jest.fn();

      supabaseMock.client.auth.getUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'JWT expired' },
      });

      await middlewareFn(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('Chưa xác thực');
      expect((socket.data as any).userId).toBeUndefined();
    });

    it('middleware xác thực thành công, gán socket.data.userId và gọi next() không có lỗi', async () => {
      const socket = {
        id: 'sock-valid',
        handshake: {
          auth: {},
          headers: { authorization: 'Bearer valid-jwt-token' },
        },
        data: {} as { userId?: string },
      };
      const next = jest.fn();

      supabaseMock.client.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null,
      });

      await middlewareFn(socket, next);

      expect(socket.data.userId).toBe('user-123');
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('handleConnection', () => {
    it('ngắt kết nối nếu socket không có userId sau middleware', async () => {
      const client = {
        id: 'sock-no-data',
        data: {},
        disconnect: jest.fn(),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as TypedSocket;

      await gateway.handleConnection(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('kết nối thành công, join user room khi có userId', async () => {
      const client = {
        id: 'sock-authenticated',
        data: { userId: 'user-123' },
        disconnect: jest.fn(),
        join: jest.fn(),
        emit: jest.fn(),
      } as unknown as TypedSocket;

      await gateway.handleConnection(client);

      expect(client.disconnect).not.toHaveBeenCalled();
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
    it('broadcast message:created tới conversation room và conversation:updated tới user rooms', async () => {
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

      await gateway.handleMessageCreated({
        conversationId: validUuid,
        channelId: null,
        message,
      });

      // message:created tới conversation room
      expect(serverMock.to).toHaveBeenCalledWith(Room.conversation(validUuid));
      expect(serverMock.emit).toHaveBeenCalledWith('message:created', {
        message,
      });

      // conversation:updated tới user room của user-456 (không phải sender user-123)
      expect(serverMock.to).toHaveBeenCalledWith(Room.user('user-456'));
      expect(serverMock.emit).toHaveBeenCalledWith('conversation:updated', expect.objectContaining({
        conversationId: validUuid,
        senderId: 'user-123',
        lastMessagePreview: 'Hello World',
        unreadDelta: 1,
      }));

      // sender KHÔNG nhận conversation:updated
      expect(serverMock.to).not.toHaveBeenCalledWith(Room.user('user-123'));

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

  describe('Presence Realtime in ChatGateway', () => {
    it('handleConnection: join user room, đăng ký PresenceService, broadcast online tới peers và gửi snapshot về client', async () => {
      const mockClient = {
        id: 'sock-alice-1',
        data: { userId: 'user-123' },
        join: jest.fn().mockResolvedValue(undefined),
        emit: jest.fn(),
      } as unknown as TypedSocket;

      await gateway.handleConnection(mockClient);

      expect(mockClient.join).toHaveBeenCalledWith(Room.user('user-123'));
      expect(presenceServiceMock.handleUserConnect).toHaveBeenCalledWith(
        'user-123',
        'sock-alice-1',
      );

      // Broadcast tới peer-bob và peer-charlie (không broadcast người lạ)
      expect(serverMock.to).toHaveBeenCalledWith(Room.user('peer-bob'));
      expect(serverMock.to).toHaveBeenCalledWith(Room.user('peer-charlie'));
      expect(serverMock.emit).toHaveBeenCalledWith('presence:updated', {
        userId: 'user-123',
        status: 'online',
        lastSeenAt: null,
      });

      // Snapshot gửi về riêng client mới connect
      expect(mockClient.emit).toHaveBeenCalledWith('presence:sync', {
        presences: {
          'peer-bob': { status: 'online', lastSeenAt: null },
          'peer-charlie': { status: 'offline', lastSeenAt: null },
        },
      });
    });

    it('handleDisconnect: gọi handleUserDisconnect và broadcast offline khi grace period kết thúc', () => {
      let offlineCb: any;
      presenceServiceMock.handleUserDisconnect.mockImplementation(
        (_socketId: string, cb: any) => {
          offlineCb = cb;
        },
      );

      const mockClient = {
        id: 'sock-alice-1',
        data: { userId: 'user-123' },
      } as unknown as TypedSocket;

      gateway.handleDisconnect(mockClient);

      expect(presenceServiceMock.handleUserDisconnect).toHaveBeenCalledWith(
        'sock-alice-1',
        expect.any(Function),
      );

      // Giả lập callback timeout grace period kích hoạt
      offlineCb({
        userId: 'user-123',
        status: 'offline',
        lastSeenAt: '2026-08-23T14:30:00.000Z',
        peers: ['peer-bob', 'peer-charlie'],
      });

      expect(serverMock.to).toHaveBeenCalledWith(Room.user('peer-bob'));
      expect(serverMock.to).toHaveBeenCalledWith(Room.user('peer-charlie'));
      expect(serverMock.emit).toHaveBeenCalledWith('presence:updated', {
        userId: 'user-123',
        status: 'offline',
        lastSeenAt: '2026-08-23T14:30:00.000Z',
      });
    });

    it('handleGetPresenceSnapshot: trả về snapshot chính xác của peers', async () => {
      const mockClient = {
        id: 'sock-alice-1',
        data: { userId: 'user-123' },
      } as unknown as TypedSocket;

      const res = await gateway.handleGetPresenceSnapshot(mockClient);
      expect(presenceServiceMock.getPeersSnapshot).toHaveBeenCalledWith('user-123');
      expect(res.presences).toEqual({
        'peer-bob': { status: 'online', lastSeenAt: null },
        'peer-charlie': { status: 'offline', lastSeenAt: null },
      });
    });
  });
});
