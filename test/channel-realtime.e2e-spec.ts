import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/infra/supabase/supabase.service';
import { Permission, DEFAULT_EVERYONE_PERMISSIONS } from '../src/shared/permissions';

describe('Server Channel Realtime & Message Parity E2E Test', () => {
  let app: INestApplication;
  let port: number;
  let socketA: Socket;
  let socketB: Socket;
  let socketC: Socket;

  const userA = { id: '11111111-1111-4111-a111-111111111111', email: 'userA@test.com' };
  const userB = { id: '22222222-2222-4222-a222-222222222222', email: 'userB@test.com' };
  const userC = { id: '33333333-3333-4333-a333-333333333333', email: 'userC@test.com' };

  const serverId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const generalChannelId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const privateChannelId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

  const mockSupabase = {
    client: {
      storage: {
        from: jest.fn().mockReturnValue({
          remove: jest.fn().mockResolvedValue({ error: null }),
          createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://storage/signed' }, error: null }),
          upload: jest.fn().mockResolvedValue({ data: { path: 'path' }, error: null }),
          copy: jest.fn().mockResolvedValue({ data: { path: 'copied-path' }, error: null }),
        }),
      },
      auth: {
        getUser: jest.fn().mockImplementation((token: string) => {
          if (token === 'token-user-a') {
            return Promise.resolve({ data: { user: userA }, error: null });
          }
          if (token === 'token-user-b') {
            return Promise.resolve({ data: { user: userB }, error: null });
          }
          if (token === 'token-user-c') {
            return Promise.resolve({ data: { user: userC }, error: null });
          }
          return Promise.resolve({ data: { user: null }, error: { message: 'Invalid token' } });
        }),
      },
      from: jest.fn().mockImplementation((table: string) => {
        const queryBuilder: any = {
          _field: null,
          _eqs: {} as Record<string, any>,
          _table: table,
        };

        queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.eq = jest.fn().mockImplementation((field: string, val: any) => {
          queryBuilder._field = field;
          queryBuilder._eqs[field] = val;
          return queryBuilder;
        });
        queryBuilder.order = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.limit = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.lt = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.gt = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.in = jest.fn().mockImplementation(() => Promise.resolve({ data: [], error: null }));
        queryBuilder.insert = jest.fn().mockImplementation((val: any) => {
          queryBuilder._inserted = val;
          return queryBuilder;
        });
        queryBuilder.update = jest.fn().mockImplementation((val: any) => {
          queryBuilder._updated = val;
          return queryBuilder;
        });
        queryBuilder.delete = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.upsert = jest.fn().mockResolvedValue({ data: null, error: null });

        queryBuilder.maybeSingle = jest.fn().mockImplementation(() => {
          if (table === 'servers') {
            return Promise.resolve({
              data: { id: serverId, owner_id: userA.id },
              error: null,
            });
          }
          if (table === 'server_members') {
            const uid = queryBuilder._eqs['user_id'];
            if (uid === userA.id) {
              return Promise.resolve({
                data: { role: 'OWNER' },
                error: null,
              });
            }
            if (uid === userB.id || uid === userC.id) {
              return Promise.resolve({
                data: { role: 'MEMBER' },
                error: null,
              });
            }
          }
          if (table === 'channels') {
            const chId = queryBuilder._eqs['id'];
            if (chId === generalChannelId) {
              return Promise.resolve({ data: { id: generalChannelId, server_id: serverId, type: 'text' }, error: null });
            }
            if (chId === privateChannelId) {
              return Promise.resolve({ data: { id: privateChannelId, server_id: serverId, type: 'text' }, error: null });
            }
          }
          if (table === 'messages') {
            if (queryBuilder._eqs['client_nonce']) {
              return Promise.resolve({ data: null, error: null });
            }
            const msgId = queryBuilder._eqs['id'];
            return Promise.resolve({
              data: {
                id: msgId || '101',
                channel_id: generalChannelId,
                conversation_id: null,
                author_id: userA.id,
                content: 'Original message',
                type: 'default',
                deleted_at: null,
              },
              error: null,
            });
          }
          if (table === 'read_states') {
            return Promise.resolve({ data: { last_read_message_id: '50' }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        });

        queryBuilder.single = jest.fn().mockImplementation(() => {
          if (table === 'messages') {
            return Promise.resolve({
              data: {
                id: '101',
                channel_id: generalChannelId,
                conversation_id: null,
                author_id: userA.id,
                content: 'Edited content',
                type: 'default',
                is_forwarded: false,
                reply_to_id: null,
                client_nonce: '33333333-3333-4333-a333-333333333333',
                edited_at: new Date().toISOString(),
                deleted_at: null,
                created_at: new Date().toISOString(),
              },
              error: null,
            });
          }
          return Promise.resolve({ data: {}, error: null });
        });

        queryBuilder.then = function (onFulfilled?: any, onRejected?: any) {
          let result: any = { data: [], error: null };
          if (table === 'channel_overwrites') {
            const chId = queryBuilder._eqs['channel_id'];
            if (chId === privateChannelId) {
              result = {
                data: [
                  {
                    target_type: 'role',
                    target_id: 'role-everyone',
                    deny: String(Permission.VIEW_CHANNEL),
                    allow: '0',
                  },
                ],
                error: null,
              };
            } else {
              result = { data: [], error: null };
            }
          } else if (table === 'roles') {
            result = {
              data: [
                {
                  id: 'role-everyone',
                  is_default: true,
                  permissions: String(DEFAULT_EVERYONE_PERMISSIONS),
                },
              ],
              error: null,
            };
          } else if (table === 'member_roles') {
            result = { data: [], error: null };
          } else if (table === 'server_members') {
            result = {
              data: [
                {
                  user_id: userA.id,
                  nickname: 'Alice',
                  role: 'OWNER',
                  joined_at: '2026-08-20T00:00:00Z',
                  profiles: { username: 'alice', display_name: 'Alice', avatar_url: null },
                },
                {
                  user_id: userB.id,
                  nickname: 'Bob',
                  role: 'MEMBER',
                  joined_at: '2026-08-21T00:00:00Z',
                  profiles: { username: 'bob', display_name: 'Bob', avatar_url: null },
                },
              ],
              error: null,
            };
          } else if (table === 'profiles') {
            result = {
              data: [
                { id: userA.id, username: 'alice', display_name: 'Alice', avatar_url: null },
                { id: userB.id, username: 'bob', display_name: 'Bob', avatar_url: null },
              ],
              error: null,
            };
          } else if (table === 'messages') {
            result = {
              data: [
                {
                  id: 101,
                  channel_id: generalChannelId,
                  conversation_id: null,
                  author_id: userA.id,
                  type: 'default',
                  content: 'Hello Channel!',
                  is_forwarded: false,
                  reply_to_id: null,
                  client_nonce: '33333333-3333-4333-a333-333333333333',
                  edited_at: null,
                  deleted_at: null,
                  created_at: '2026-08-24T10:00:00Z',
                },
              ],
              error: null,
            };
          } else if (table === 'message_reactions') {
            result = {
              data: [{ emoji: '🔥', user_id: userB.id }],
              error: null,
            };
          }

          return Promise.resolve(result).then(onFulfilled, onRejected);
        };

        return queryBuilder;
      }),
      rpc: jest.fn().mockImplementation((rpcName: string, params: any) => {
        if (rpcName === 'create_channel_message') {
          return Promise.resolve({
            data: {
              id: '201',
              channelId: params.p_channel_id,
              authorId: params.p_author_id,
              type: 'default',
              content: params.p_content,
              replyToId: null,
              clientNonce: params.p_client_nonce,
              createdAt: new Date().toISOString(),
              attachments: [],
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'string' ? 0 : address.port;
  });

  afterAll(async () => {
    socketA?.disconnect();
    socketB?.disconnect();
    socketC?.disconnect();
    await app?.close();
  });

  it('1. User A và User B kết nối Socket.IO thành công và join general channel', async () => {
    socketA = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-a' },
      transports: ['websocket'],
    });

    socketB = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-b' },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise<void>((resolve) => socketA.on('connect', () => resolve())),
      new Promise<void>((resolve) => socketB.on('connect', () => resolve())),
    ]);

    // Join general channel
    const [resA, resB]: any = await Promise.all([
      new Promise((res) => socketA.emit('channel:join', { channelId: generalChannelId }, res)),
      new Promise((res) => socketB.emit('channel:join', { channelId: generalChannelId }, res)),
    ]);

    expect(resA.success).toBe(true);
    expect(resB.success).toBe(true);
  });

  it('2. User C bị từ chối khi cố join private channel mà không có VIEW_CHANNEL', async () => {
    socketC = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-c' },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve) => socketC.on('connect', () => resolve()));

    const resC: any = await new Promise((res) =>
      socketC.emit('channel:join', { channelId: privateChannelId }, res),
    );

    expect(resC.success).toBe(false);
    expect(resC.status).toBe('rejected');
  });

  it('3. User A gửi tin nhắn vào channel qua REST POST -> User B nhận message:created realtime', async () => {
    const messagePromise = new Promise<any>((resolve) => {
      socketB.once('message:created', (payload) => {
        resolve(payload);
      });
    });

    const res = await request(app.getHttpServer())
      .post(`/channels/${generalChannelId}/messages`)
      .set('Authorization', 'Bearer token-user-a')
      .send({ content: 'Hello everyone in server channel!', clientNonce: '11111111-1111-4111-a111-111111111111' });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('Hello everyone in server channel!');

    const received: any = await messagePromise;
    expect(received.message.content).toBe('Hello everyone in server channel!');
    expect(received.message.channelId).toBe(generalChannelId);
  });

  it('4. User B thả reaction vào message -> User A nhận message:reaction-updated realtime', async () => {
    const reactionPromise = new Promise<any>((resolve) => {
      socketA.once('message:reaction-updated', (payload) => {
        resolve(payload);
      });
    });

    const res = await request(app.getHttpServer())
      .post(`/channels/${generalChannelId}/messages/101/reactions`)
      .set('Authorization', 'Bearer token-user-b')
      .send({ emoji: '🔥', reacted: true });

    expect(res.status).toBe(201);

    const received: any = await reactionPromise;
    expect(received.channelId).toBe(generalChannelId);
    expect(received.emoji).toBe('🔥');
    expect(received.actorUserId).toBe(userB.id);
  });

  it('5. User A gõ phím trong channel -> User B nhận typing:updated realtime', async () => {
    const typingPromise = new Promise<any>((resolve) => {
      socketB.once('typing:updated', (payload) => {
        resolve(payload);
      });
    });

    socketA.emit('typing:start', { channelId: generalChannelId });

    const received: any = await typingPromise;
    expect(received.channelId).toBe(generalChannelId);
    expect(received.userIds).toContain(userA.id);
  });

  it('6. User B mark channel read -> User A nhận message:read realtime', async () => {
    const readPromise = new Promise<any>((resolve) => {
      socketA.once('message:read', (payload) => {
        resolve(payload);
      });
    });

    const res = await request(app.getHttpServer())
      .post(`/channels/${generalChannelId}/read`)
      .set('Authorization', 'Bearer token-user-b')
      .send({ messageId: '101' });

    expect(res.status).toBe(201);

    const received: any = await readPromise;
    expect(received.channelId).toBe(generalChannelId);
    expect(received.lastReadMessageId).toBe('101');
  });

  it('7. User A chỉnh sửa tin nhắn -> User B nhận message:updated realtime', async () => {
    const updatePromise = new Promise<any>((resolve) => {
      socketB.once('message:updated', (payload) => {
        resolve(payload);
      });
    });

    const res = await request(app.getHttpServer())
      .patch('/messages/101')
      .set('Authorization', 'Bearer token-user-a')
      .send({ content: 'Edited content' });

    expect(res.status).toBe(200);

    const received: any = await updatePromise;
    expect(received.message.content).toBe('Edited content');
  });

  it('8. User A xóa tin nhắn -> User B nhận message:deleted realtime', async () => {
    const deletePromise = new Promise<any>((resolve) => {
      socketB.once('message:deleted', (payload) => {
        resolve(payload);
      });
    });

    const res = await request(app.getHttpServer())
      .delete('/messages/101')
      .set('Authorization', 'Bearer token-user-a');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const received: any = await deletePromise;
    expect(received.messageId).toBe('101');
    expect(received.channelId).toBe(generalChannelId);
  });
});
