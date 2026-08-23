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
      storage: {
        from: jest.fn().mockReturnValue({
          remove: jest.fn().mockResolvedValue({ error: null }),
          createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'signed-url' }, error: null }),
          upload: jest.fn().mockResolvedValue({ data: { path: 'path' }, error: null }),
        }),
      },
      auth: {
        getUser: jest.fn().mockImplementation((token: string) => {
          if (token === 'token-user-a' || token === 'refreshed-token-user-a') {
            return Promise.resolve({ data: { user: userA }, error: null });
          }
          if (token === 'token-user-b' || token === 'refreshed-token-user-b') {
            return Promise.resolve({ data: { user: userB }, error: null });
          }
          if (token === 'delayed-token-user-a') {
            return new Promise((res) =>
              setTimeout(() => res({ data: { user: userA }, error: null }), 120),
            );
          }
          if (token === 'delayed-token-user-b') {
            return new Promise((res) =>
              setTimeout(() => res({ data: { user: userB }, error: null }), 200),
            );
          }
          return Promise.resolve({ data: { user: null }, error: { message: 'Invalid token' } });
        }),
      },
      from: jest.fn().mockImplementation((table: string) => {
        const queryBuilder: any = {
          _field: null,
          _updates: null,
          _table: table,
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
        queryBuilder.in = jest.fn().mockImplementation((field: string, values: any[]) => {
          return Promise.resolve({ data: [], error: null });
        });
        queryBuilder.insert = jest.fn().mockImplementation((val: any) => {
          queryBuilder._insertedVal = val;
          return queryBuilder;
        });
        queryBuilder.update = jest.fn().mockImplementation((updates: any) => {
          queryBuilder._updates = updates;
          return queryBuilder;
        });
        queryBuilder.delete = jest.fn().mockReturnValue(queryBuilder);

        // Make queryBuilder thenable so `await supabase.from(...).select().eq()` works
        // This is needed for getParticipantIds which doesn't call .maybeSingle()/.single()
        queryBuilder.then = function (resolve: any, reject?: any) {
          if (table === 'conversation_participants' && queryBuilder._field === 'conversation_id') {
            // getParticipantIds: return both participants
            return Promise.resolve({
              data: [
                { user_id: userA.id },
                { user_id: userB.id },
              ],
              error: null,
            }).then(resolve, reject);
          }
          if (table === 'message_reactions') {
            return Promise.resolve({
              data: [
                { message_id: '101', user_id: userA.id, emoji: '❤️' },
              ],
              error: null,
            }).then(resolve, reject);
          }
          // Default: resolve with empty
          return Promise.resolve({ data: [{ message_id: '101' }], error: null }).then(resolve, reject);
        };

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

  it('10. conversation:join ack bao gồm status: joined', async () => {
    // Tạo socket mới để test join ack
    const socketTest = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-a' },
      transports: ['websocket'],
    });
    await new Promise((res) => socketTest.on('connect', res));

    const joinRes = await new Promise<{ success: boolean; status?: string }>((res) => {
      socketTest.emit('conversation:join', { conversationId: convId }, res);
    });

    expect(joinRes.success).toBe(true);
    expect(joinRes.status).toBe('joined');

    socketTest.disconnect();
  });

  it('11. User B nhận conversation:updated trên user room khi A gửi tin', async () => {
    // socketB đã disconnect ở test trước, tạo lại
    socketB = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-b' },
      transports: ['websocket'],
    });
    await new Promise((res) => socketB.on('connect', res));

    // B KHÔNG join conversation room, chỉ có user room (auto-join trong handleConnection)
    const updatedPromise = new Promise<any>((resolve) => {
      socketB.once('conversation:updated', (payload) => {
        resolve(payload);
      });
    });

    const messagesService = app.get(MessagesService);
    await messagesService.createConversationMessage(userA.id, convId, {
      content: 'Hello from user room!',
    });

    const updated = await updatedPromise;
    expect(updated.conversationId).toBe(convId);
    expect(updated.senderId).toBe(userA.id);
    expect(updated.lastMessagePreview).toBe('Hello from user room!');
    expect(updated.unreadDelta).toBe(1);
    expect(updated.lastMessageId).toBeDefined();
    expect(updated.lastMessageAt).toBeDefined();
  });

  it('12. Sender A KHÔNG nhận conversation:updated trên user room của chính mình', async () => {
    // Tạo lại socketA
    socketA = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-a' },
      transports: ['websocket'],
    });
    await new Promise((res) => socketA.on('connect', res));

    let senderReceivedUpdate = false;
    socketA.once('conversation:updated', () => {
      senderReceivedUpdate = true;
    });

    const messagesService = app.get(MessagesService);
    await messagesService.createConversationMessage(userA.id, convId, {
      content: 'Should not notify sender',
    });

    // Chờ 300ms để đảm bảo không nhận event
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(senderReceivedUpdate).toBe(false);
  });

  it('13. User B ở khác room vẫn nhận conversation:updated mà không cần join conversation room', async () => {
    // B join conversation room khác (otherConvId), không join convId
    await new Promise<{ success: boolean }>((res) => {
      socketB.emit('conversation:join', { conversationId: otherConvId }, res);
    });

    let leakedMessage = false;
    socketB.once('message:created', () => {
      leakedMessage = true;
    });

    const updatedPromise = new Promise<any>((resolve) => {
      socketB.once('conversation:updated', (payload) => {
        resolve(payload);
      });
    });

    const messagesService = app.get(MessagesService);
    await messagesService.createConversationMessage(userA.id, convId, {
      content: 'User room notification test',
    });

    const updated = await updatedPromise;
    expect(updated.conversationId).toBe(convId);
    expect(updated.lastMessagePreview).toBe('User room notification test');

    // message:created KHÔNG lọt sang vì B không ở conversation room của convId
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(leakedMessage).toBe(false);
  });

  it('14. User A thả cảm xúc -> User B trong cùng conversation nhận message:reaction-updated realtime', async () => {
    // User A và B đều join convId
    await Promise.all([
      new Promise<{ success: boolean }>((res) => {
        socketA.emit('conversation:join', { conversationId: convId }, res);
      }),
      new Promise<{ success: boolean }>((res) => {
        socketB.emit('conversation:join', { conversationId: convId }, res);
      }),
    ]);

    const reactionPromise = new Promise<any>((resolve) => {
      socketB.once('message:reaction-updated', (payload) => {
        resolve(payload);
      });
    });

    const messagesService = app.get(MessagesService);
    const clientMutationId = '77777777-7777-4777-a777-777777777777';

    await messagesService.setReaction(userA.id, convId, '101', {
      emoji: '❤️',
      reacted: true,
      clientMutationId,
    });

    const received = await reactionPromise;
    expect(received.messageId).toBe('101');
    expect(received.conversationId).toBe(convId);
    expect(received.actorUserId).toBe(userA.id);
    expect(received.emoji).toBe('❤️');
    expect(received.action).toBe('added');
    expect(received.clientMutationId).toBe(clientMutationId);
    expect(received.reactions).toBeDefined();
  });

  it('15. User ở khác conversation room KHÔNG nhận message:reaction-updated', async () => {
    // User B rời convId và join otherConvId
    socketB.emit('conversation:leave', { conversationId: convId });
    await new Promise<{ success: boolean }>((res) => {
      socketB.emit('conversation:join', { conversationId: otherConvId }, res);
    });

    let leakedReaction = false;
    socketB.once('message:reaction-updated', () => {
      leakedReaction = true;
    });

    const messagesService = app.get(MessagesService);
    await messagesService.setReaction(userA.id, convId, '101', {
      emoji: '👍',
      reacted: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(leakedReaction).toBe(false);
  });

  it('16. Supabase getUser() bị delay: conversation:join chỉ được xử lý sau khi auth hoàn tất -> ack status: joined', async () => {
    const delayedSocket = io(`http://localhost:${port}/chat`, {
      auth: { token: 'delayed-token-user-a' },
      transports: ['websocket'],
    });

    try {
      // Ngay khi connect được emit (chắc chắn middleware auth đã xong), emit conversation:join
      const joinResult = await new Promise<any>((resolve) => {
        delayedSocket.on('connect', () => {
          delayedSocket.emit(
            'conversation:join',
            { conversationId: convId },
            (res: any) => resolve(res),
          );
        });
      });

      expect(joinResult.success).toBe(true);
      expect(joinResult.status).toBe('joined');
    } finally {
      delayedSocket.disconnect();
    }
  });

  it('17. Token sai / hết hạn: nhận connect_error và không thể gọi handler', async () => {
    const badSocket = io(`http://localhost:${port}/chat`, {
      auth: { token: 'bad-or-expired-token' },
      transports: ['websocket'],
    });

    try {
      const errorMsg = await new Promise<string>((resolve) => {
        badSocket.on('connect_error', (err) => {
          resolve(err.message);
        });
      });

      expect(errorMsg).toBe('Chưa xác thực');
      expect(badSocket.connected).toBe(false);
    } finally {
      badSocket.disconnect();
    }
  });

  it('18. Hai client có thời gian auth khác nhau (A nhanh, B chậm) vẫn join cùng room thành công', async () => {
    const clientFast = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-a' },
      transports: ['websocket'],
    });
    const clientSlow = io(`http://localhost:${port}/chat`, {
      auth: { token: 'delayed-token-user-b' },
      transports: ['websocket'],
    });

    try {
      const [resA, resB] = await Promise.all([
        new Promise<any>((resolve) => {
          clientFast.on('connect', () => {
            clientFast.emit('conversation:join', { conversationId: convId }, resolve);
          });
        }),
        new Promise<any>((resolve) => {
          clientSlow.on('connect', () => {
            clientSlow.emit('conversation:join', { conversationId: convId }, resolve);
          });
        }),
      ]);

      expect(resA.success).toBe(true);
      expect(resA.status).toBe('joined');
      expect(resB.success).toBe(true);
      expect(resB.status).toBe('joined');
    } finally {
      clientFast.disconnect();
      clientSlow.disconnect();
    }
  });

  it('19. Hai chiều realtime reaction: A reaction -> B nhận, và B reaction -> A nhận', async () => {
    // Join convId cho cả socketA và socketB
    await Promise.all([
      new Promise<{ success: boolean }>((res) => {
        socketA.emit('conversation:join', { conversationId: convId }, res);
      }),
      new Promise<{ success: boolean }>((res) => {
        socketB.emit('conversation:join', { conversationId: convId }, res);
      }),
    ]);

    const messagesService = app.get(MessagesService);

    // Chiều 1: A thả ❤️ -> B nhận
    const bReceivedPromise = new Promise<any>((resolve) => {
      socketB.once('message:reaction-updated', resolve);
    });

    await messagesService.setReaction(userA.id, convId, '101', {
      emoji: '❤️',
      reacted: true,
      clientMutationId: '11111111-aaaa-4111-a111-111111111111',
    });

    const bReceived = await bReceivedPromise;
    expect(bReceived.messageId).toBe('101');
    expect(bReceived.actorUserId).toBe(userA.id);
    expect(bReceived.emoji).toBe('❤️');
    expect(bReceived.action).toBe('added');

    // Chờ 50ms để sự kiện Chiều 1 hoàn tất trên socketA
    await new Promise((res) => setTimeout(res, 50));

    // Chiều 2: B thả 🌿 -> A nhận
    const aReceivedPromise = new Promise<any>((resolve) => {
      socketA.once('message:reaction-updated', resolve);
    });

    await messagesService.setReaction(userB.id, convId, '101', {
      emoji: '🌿',
      reacted: true,
      clientMutationId: '22222222-bbbb-4222-a222-222222222222',
    });

    const aReceived = await aReceivedPromise;
    expect(aReceived.messageId).toBe('101');
    expect(aReceived.actorUserId).toBe(userB.id);
    expect(aReceived.emoji).toBe('🌿');
    expect(aReceived.action).toBe('added');
  });

  it('20. Reconnect sau token refresh: cập nhật token, tự join lại conversation room và tiếp tục nhận reaction', async () => {
    const reconnectingSocket = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-b' },
      transports: ['websocket'],
    });

    try {
      await new Promise((res) => reconnectingSocket.on('connect', res));

      // Join room ban đầu
      await new Promise<any>((resolve) => {
        reconnectingSocket.emit('conversation:join', { conversationId: convId }, resolve);
      });

      // Giả lập token refresh và reconnect
      reconnectingSocket.auth = { token: 'refreshed-token-user-b' };
      reconnectingSocket.disconnect();
      reconnectingSocket.connect();

      await new Promise((res) => reconnectingSocket.on('connect', res));

      // Auto-rejoin room sau connect
      await new Promise<any>((resolve) => {
        reconnectingSocket.emit('conversation:join', { conversationId: convId }, resolve);
      });

      const reactionPromise = new Promise<any>((resolve) => {
        reconnectingSocket.once('message:reaction-updated', resolve);
      });

      const messagesService = app.get(MessagesService);
      await messagesService.setReaction(userA.id, convId, '101', {
        emoji: '🔥',
        reacted: true,
        clientMutationId: '33333333-cccc-4333-a333-333333333333',
      });

      const received = await reactionPromise;
      expect(received.messageId).toBe('101');
      expect(received.actorUserId).toBe(userA.id);
      expect(received.emoji).toBe('🔥');
    } finally {
      reconnectingSocket.disconnect();
    }
  });
});

