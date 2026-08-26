import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/infra/supabase/supabase.service';
import { DirectCallTokenService } from '../src/modules/direct-calls/direct-call-token.service';
import { DirectCallsService } from '../src/modules/direct-calls/direct-calls.service';

describe('Direct Calls Realtime E2E & Webhook Security Test', () => {
  let app: INestApplication;
  let port: number;
  let socketA: Socket;
  let socketB: Socket;
  let directCallsService: DirectCallsService;

  const userA = { id: '11111111-1111-4111-a111-111111111111', email: 'userA@test.com' };
  const userB = { id: '22222222-2222-4222-a222-222222222222', email: 'userB@test.com' };
  const userC = { id: '33333333-3333-4333-a333-333333333333', email: 'userC@test.com' };
  const convId = '44444444-4444-4444-a444-444444444444';
  const callId = '55555555-5555-4555-a555-555555555555';
  const callerSessionId = 'session-caller-tab1';
  const calleeSessionId = 'session-callee-tab1';

  let hasConnectedTransitioned = false;

  let currentCallState: any = {
    id: callId,
    conversation_id: convId,
    caller_id: userA.id,
    callee_id: userB.id,
    caller_session_id: callerSessionId,
    answered_session_id: null,
    initial_mode: 'video',
    status: 'ringing',
    livekit_room_name: `nexus:dm-call:${callId}`,
    initiated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 45000).toISOString(),
    answered_at: null,
    connected_at: null,
    ended_at: null,
    ended_by: null,
    end_reason: null,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

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
          if (token === 'token-user-c') {
            return Promise.resolve({ data: { user: userC }, error: null });
          }
          return Promise.resolve({ data: { user: null }, error: { message: 'Invalid token' } });
        }),
      },
      from: jest.fn().mockImplementation((table: string) => {
        const queryBuilder: any = {};
        queryBuilder.select = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.in = jest.fn().mockResolvedValue({
          data: [
            { id: userA.id, username: 'userA', display_name: 'User A', avatar_url: null },
            { id: userB.id, username: 'userB', display_name: 'User B', avatar_url: null },
          ],
          error: null,
        });
        queryBuilder.or = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.eq = jest.fn().mockImplementation((field: string, val: string) => {
          if (table === 'direct_calls' && field === 'id') {
            queryBuilder._callId = val;
          }
          return queryBuilder;
        });
        queryBuilder.order = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.limit = jest.fn().mockReturnValue(queryBuilder);
        queryBuilder.maybeSingle = jest.fn().mockImplementation(() => {
          if (table === 'direct_calls') {
            return Promise.resolve({ data: currentCallState, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        });
        return queryBuilder;
      }),
      rpc: jest.fn().mockImplementation((fn: string, params: any) => {
        if (fn === 'start_direct_call') {
          currentCallState.status = 'ringing';
          return Promise.resolve({ data: [currentCallState], error: null });
        }
        if (fn === 'answer_direct_call') {
          currentCallState.status = 'accepted';
          currentCallState.answered_session_id = params.p_client_session_id;
          currentCallState.should_join_media = params.p_client_session_id === calleeSessionId;
          return Promise.resolve({ data: [currentCallState], error: null });
        }
        if (fn === 'end_direct_call') {
          currentCallState.status = 'ended';
          currentCallState.ended_by = params.p_user_id;
          currentCallState.end_reason = params.p_end_reason;
          return Promise.resolve({ data: [currentCallState], error: null });
        }
        if (fn === 'decline_direct_call') {
          currentCallState.status = 'declined';
          return Promise.resolve({ data: [currentCallState], error: null });
        }
        if (fn === 'cancel_direct_call') {
          currentCallState.status = 'cancelled';
          return Promise.resolve({ data: [currentCallState], error: null });
        }
        if (fn === 'mark_direct_call_connected') {
          if (!hasConnectedTransitioned) {
            hasConnectedTransitioned = true;
            currentCallState.connected_at = new Date().toISOString();
            return Promise.resolve({
              data: [{ ...currentCallState, did_transition: true }],
              error: null,
            });
          }
          return Promise.resolve({
            data: [{ ...currentCallState, did_transition: false }],
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    },
  };

  const mockTokenService = {
    generateToken: jest.fn().mockResolvedValue({
      serverUrl: 'wss://livekit.test',
      participantToken: 'mock_jwt_token',
      roomName: `nexus:dm-call:${callId}`,
      participantIdentity: userA.id,
      participantName: 'User A',
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(mockSupabase)
      .overrideProvider(DirectCallTokenService)
      .useValue(mockTokenService)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);

    directCallsService = app.get(DirectCallsService);

    const address = app.getHttpServer().address();
    port = typeof address === 'string' ? 3000 : address.port;

    // Connect socket A (User A)
    socketA = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-a' },
      transports: ['websocket'],
    });

    // Connect socket B (User B)
    socketB = io(`http://localhost:${port}/chat`, {
      auth: { token: 'token-user-b' },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise<void>((resolve) => socketA.on('connect', resolve)),
      new Promise<void>((resolve) => socketB.on('connect', resolve)),
    ]);
  });

  afterAll(async () => {
    if (socketA?.connected) socketA.disconnect();
    if (socketB?.connected) socketB.disconnect();
    await app.close();
  });

  it('1. POST /api/direct-calls creates call and emits incoming/ringing events', async () => {
    const incomingPromise = new Promise<any>((resolve) => {
      socketB.once('direct-call:incoming', resolve);
    });
    const ringingPromise = new Promise<any>((resolve) => {
      socketA.once('direct-call:ringing', resolve);
    });

    const res = await request(app.getHttpServer())
      .post('/api/direct-calls')
      .set('Authorization', 'Bearer token-user-a')
      .send({
        conversationId: convId,
        initialMode: 'video',
        clientSessionId: callerSessionId,
      })
      .expect(201);

    expect(res.body.id).toBe(callId);
    expect(res.body.status).toBe('ringing');

    const incomingCall = await incomingPromise;
    const ringingCall = await ringingPromise;

    expect(incomingCall.id).toBe(callId);
    expect(ringingCall.id).toBe(callId);
  });

  it('2. POST /api/direct-calls/:id/answer accepts call and emits accepted event', async () => {
    const acceptedAPromise = new Promise<any>((resolve) => {
      socketA.once('direct-call:accepted', resolve);
    });
    const acceptedBPromise = new Promise<any>((resolve) => {
      socketB.once('direct-call:accepted', resolve);
    });

    const res = await request(app.getHttpServer())
      .post(`/api/direct-calls/${callId}/answer`)
      .set('Authorization', 'Bearer token-user-b')
      .send({
        clientSessionId: calleeSessionId,
      })
      .expect(200);

    expect(res.body.shouldJoinMedia).toBe(true);
    expect(res.body.call.status).toBe('accepted');

    const acceptedCallA = await acceptedAPromise;
    const acceptedCallB = await acceptedBPromise;

    expect(acceptedCallA.id).toBe(callId);
    expect(acceptedCallB.id).toBe(callId);
  });

  it('3. POST /api/direct-calls/:id/token enforces media ownership and rejects rogue tabs', async () => {
    // Valid media owner (User A caller session)
    const validRes = await request(app.getHttpServer())
      .post(`/api/direct-calls/${callId}/token`)
      .set('Authorization', 'Bearer token-user-a')
      .send({ clientSessionId: callerSessionId })
      .expect(200);

    expect(validRes.body.participantToken).toBe('mock_jwt_token');

    // Rogue tab with wrong session id -> 403 Forbidden
    await request(app.getHttpServer())
      .post(`/api/direct-calls/${callId}/token`)
      .set('Authorization', 'Bearer token-user-a')
      .send({ clientSessionId: 'rogue-session-tab99' })
      .expect(403);

    // Non-participant user -> 403 Forbidden
    await request(app.getHttpServer())
      .post(`/api/direct-calls/${callId}/token`)
      .set('Authorization', 'Bearer token-user-c')
      .send({ clientSessionId: callerSessionId })
      .expect(403);
  });

  it('4. POST /api/direct-calls/webhook validates signatures and guarantees idempotent socket emission', async () => {
    // A. Webhook without Authorization header -> 400 Bad Request
    await request(app.getHttpServer())
      .post('/api/direct-calls/webhook')
      .send({ event: 'participant_joined' })
      .expect(400);

    // Mock WebhookReceiver for testing valid/invalid signatures
    const mockReceiver: any = {
      receive: jest.fn().mockImplementation((body: string, auth: string) => {
        if (auth === 'invalid-auth-signature') {
          throw new Error('Signature checksum mismatch');
        }
        return Promise.resolve({
          event: 'participant_joined',
          room: { name: `nexus:dm-call:${callId}` },
        });
      }),
    };
    (directCallsService as any).webhookReceiver = mockReceiver;

    // B. Webhook with invalid signature -> 400 Bad Request
    await request(app.getHttpServer())
      .post('/api/direct-calls/webhook')
      .set('Authorization', 'invalid-auth-signature')
      .send({ event: 'participant_joined' })
      .expect(400);

    // C. Webhook with valid signature -> 200 OK and emits direct-call:connected exactly once
    let connectedEmittedCount = 0;
    socketA.on('direct-call:connected', () => {
      connectedEmittedCount++;
    });

    await request(app.getHttpServer())
      .post('/api/direct-calls/webhook')
      .set('Authorization', 'valid-auth-signature')
      .send({ event: 'participant_joined' })
      .expect(200);

    await new Promise((r) => setTimeout(r, 100));
    expect(connectedEmittedCount).toBe(1);

    // D. Duplicate webhook -> 200 OK, but did_transition=false so 0 extra direct-call:connected emitted
    await request(app.getHttpServer())
      .post('/api/direct-calls/webhook')
      .set('Authorization', 'valid-auth-signature')
      .send({ event: 'participant_joined' })
      .expect(200);

    await new Promise((r) => setTimeout(r, 100));
    expect(connectedEmittedCount).toBe(1); // Still exactly 1!
  });

  it('5. POST /api/direct-calls/:id/end terminates call and emits ended event', async () => {
    const endedAPromise = new Promise<any>((resolve) => {
      socketA.once('direct-call:ended', resolve);
    });
    const endedBPromise = new Promise<any>((resolve) => {
      socketB.once('direct-call:ended', resolve);
    });

    const res = await request(app.getHttpServer())
      .post(`/api/direct-calls/${callId}/end`)
      .set('Authorization', 'Bearer token-user-a')
      .send({ reason: 'hangup' })
      .expect(200);

    expect(res.body.status).toBe('ended');

    const endedCallA = await endedAPromise;
    const endedCallB = await endedBPromise;

    expect(endedCallA.id).toBe(callId);
    expect(endedCallB.id).toBe(callId);
  });
});
