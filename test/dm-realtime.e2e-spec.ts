import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/infra/supabase/supabase.service';
import { MessagesService } from '../src/modules/messages/messages.service';

describe('Direct Messages In-Process Integration Test (Mocked Supabase)', () => {
  let app: INestApplication;
  let port: number;
  let socketA: Socket;
  let socketB: Socket;

  const userA = { id: '11111111-1111-4111-a111-111111111111', email: 'userA@test.com' };
  const userB = { id: '22222222-2222-4222-a222-222222222222', email: 'userB@test.com' };
  const convId = '33333333-3333-4333-a333-333333333333';
  const otherConvId = '44444444-4444-4444-a444-444444444444';

  const mockSupabase = {
    client: {
      auth: {
        getUser: jest.fn().mockImplementation((token: string) => {
          if (token === 'token-user-a') {
            return Promise.resolve({ data: { user: userA }, error: null });
          }
          if (token === 'token-user-b') {
            return Promise.resolve({ data: { user: userB }, error: null });
          }
          return Promise.resolve({ data: { user: null }, error: { message: 'Invalid token' } });
        }),
      },
      from: jest.fn().mockImplementation((table: string) => {
        const queryBuilder: any = {
          _field: null,
          _updates: null,
        };

        queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.eq = jest.fn().mockImplementation((field: string) => {
          queryBuilder._field = field;
          return queryBuilder;
        });
        queryBuilder.order = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.limit = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.lt = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.gt = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.insert = jest.fn().mockImplementation((val: any) => {
          queryBuilder._insertedVal = val;
          return queryBuilder;
        });
        queryBuilder.update = jest.fn().mockImplementation((updates: any) => {
          queryBuilder._updates = updates;
          return queryBuilder;
        });
        queryBuilder.delete = jest.fn().mockReturnValue(queryBuilder);

        queryBuilder.maybeSingle = jest.fn().mockImplementation(async () => {
          if (table === 'conversation_participants') {
            return { data: { conversation_id: convId, user_id: userA.id }, error: null };
          }
          if (table === 'profiles') {
            return {
              data: { id: userA.id, username: 'usera', display_name: 'User A', avatar_url: null },
              error: null,
            };
          }
          if (table === 'messages') {
            // Khi kiểm tra idempotency client_nonce -> chưa tồn tại
            if (queryBuilder._field === 'client_nonce') {
              return { data: null, error: null };
            }
            return {
              data: {
                id: '101',
                conversation_id: convId,
                author_id: userA.id,
                content: queryBuilder._updates?.content ?? queryBuilder._insertedVal?.content ?? 'Hello Realtime',
                type: 'default',
                reply_to_id: null,
                client_nonce: 'nonce-1',
                deleted_at: null,
                created_at: new Date().toISOString(),
              },
              error: null,
            };
          }
          return { data: null, error: null };
        });

        queryBuilder.single = jest.fn().mockImplementation(async () => {
          if (table === 'messages') {
            return {
              data: {
                id: '101',
                conversation_id: convId,
                author_id: userA.id,
                content: queryBuilder._updates?.content ?? queryBuilder._insertedVal?.content ?? 'Hello Realtime',
                type: 'default',
                reply_to_id: null,
                client_nonce: 'nonce-1',
                deleted_at: null,
                created_at: new Date().toISOString(),
              },
              error: null,
            };
          }
          return { data: null, error: null };
        });

        return queryBuilder;
      }),
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(mockSupabase)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    port = typeof address === 'string' ? 3000 : address.port;
  });

  afterAll(async () => {
    for (const socket of [socketA, socketB]) {
      try {
        socket?.removeAllListeners();
        socket?.disconnect();
      } catch {
        // Ignore teardown errors
      }
    }
    await app.close();
  });

  it('1. Xác thực handshake và kết nối Socket cho User A và User B', async () => {
    socketA = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-a' },
      transports: ['websocket'],
    });

    socketB = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-b' },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise((res) => socketA.on('connect', res)),
      new Promise((res) => socketB.on('connect', res)),
    ]);

    expect(socketA.connected).toBe(true);
    expect(socketB.connected).toBe(true);
  });

  it('2. Join room conversation với Acknowledgment', async () => {
    const joinResA = await new Promise<{ success: boolean }>((res) => {
      socketA.emit('conversation:join', { conversationId: convId }, res);
    });
    const joinResB = await new Promise<{ success: boolean }>((res) => {
      socketB.emit('conversation:join', { conversationId: convId }, res);
    });

    expect(joinResA.success).toBe(true);
    expect(joinResB.success).toBe(true);
  });

  it('3. User A gửi tin nhắn -> User B nhận duy nhất 1 sự kiện message:created', async () => {
    const messagesService = app.get(MessagesService);

    const receivePromise = new Promise<any>((resolve) => {
      socketB.once('message:created', (payload) => {
        resolve(payload);
      });
    });

    await messagesService.createConversationMessage(userA.id, convId, {
      content: 'Hello Realtime',
      clientNonce: 'nonce-1',
    });

    const received = await receivePromise;
    expect(received.message.content).toBe('Hello Realtime');
    expect(received.message.conversationId).toBe(convId);
    expect(received.message.id).toBe('101');
  });

  it('4. User A gõ phím -> User B nhận typing:updated', async () => {
    const typingPromise = new Promise<any>((resolve) => {
      socketB.once('typing:updated', (payload) => {
        resolve(payload);
      });
    });

    socketA.emit('typing:start', { conversationId: convId });

    const payload = await typingPromise;
    expect(payload.conversationId).toBe(convId);
    expect(payload.userIds).toContain(userA.id);
  });

  it('5. User A sửa tin nhắn -> User B nhận message:updated', async () => {
    const messagesService = app.get(MessagesService);

    const updatePromise = new Promise<any>((resolve) => {
      socketB.once('message:updated', (payload) => {
        resolve(payload);
      });
    });

    await messagesService.editMessage(userA.id, '101', {
      content: 'Edited Realtime Message',
    });

    const updated = await updatePromise;
    expect(updated.message.content).toBe('Edited Realtime Message');
  });

  it('6. User A xoá tin nhắn -> User B nhận message:deleted', async () => {
    const messagesService = app.get(MessagesService);

    const deletePromise = new Promise<any>((resolve) => {
      socketB.once('message:deleted', (payload) => {
        resolve(payload);
      });
    });

    await messagesService.deleteMessage(userA.id, '101');

    const deleted = await deletePromise;
    expect(deleted.messageId).toBe('101');
  });

  it('7. Tin nhắn từ conversation khác không lọt vào room hiện tại', async () => {
    const messagesService = app.get(MessagesService);
    let leaked = false;

    socketB.once('message:created', () => {
      leaked = true;
    });

    // Phát tin nhắn ở otherConvId
    await messagesService.createConversationMessage(userA.id, otherConvId, {
      content: 'Message in other conversation',
    });

    // Chờ 200ms để đảm bảo không nhận được event
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(leaked).toBe(false);
  });

  it('8. User B đánh dấu đã đọc -> User A nhận message:read', async () => {
    mockSupabase.client.rpc = jest.fn().mockResolvedValue({
      data: [{ success: true, updated: true, last_read_message_id: '101' }],
      error: null,
    });

    const messagesService = app.get(MessagesService);

    const readPromise = new Promise<any>((resolve) => {
      socketA.once('message:read', (payload) => {
        resolve(payload);
      });
    });

    await messagesService.markAsRead(userB.id, convId, '101');

    const readPayload = await readPromise;
    expect(readPayload.conversationId).toBe(convId);
    expect(readPayload.userId).toBe(userB.id);
    expect(readPayload.lastReadMessageId).toBe('101');
  });

  it('9. User B disconnect và reconnect socket -> rejoin room thành công', async () => {
    socketB.disconnect();

    const reconnectSocketB = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-b' },
      transports: ['websocket'],
    });

    await new Promise((res) => reconnectSocketB.on('connect', res));
    const joinRes = await new Promise<{ success: boolean }>((res) => {
      reconnectSocketB.emit('conversation:join', { conversationId: convId }, res);
    });

    expect(joinRes.success).toBe(true);

    // Gửi tin nhắn kiểm tra B sau khi reconnect vẫn nhận được
    const messagesService = app.get(MessagesService);
    const receivePromise = new Promise<any>((resolve) => {
      reconnectSocketB.once('message:created', (payload) => {
        resolve(payload);
      });
    });

    await messagesService.createConversationMessage(userA.id, convId, {
      content: 'Message after reconnect',
    });

    const received = await receivePromise;
    expect(received.message.content).toBe('Message after reconnect');

    reconnectSocketB.disconnect();
  });
});
