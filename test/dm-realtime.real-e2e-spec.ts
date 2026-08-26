import { io, Socket } from 'socket.io-client';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

const isRealE2ERequested = process.env.RUN_REAL_DM_E2E === 'true';
const userAEmail = process.env.DM_E2E_USER_A_EMAIL;
const userAPassword = process.env.DM_E2E_USER_A_PASSWORD;
const userBEmail = process.env.DM_E2E_USER_B_EMAIL;
const userBPassword = process.env.DM_E2E_USER_B_PASSWORD;
const userBUsername = process.env.DM_E2E_USER_B_USERNAME;
const apiUrl = process.env.DM_E2E_API_URL || 'http://localhost:3000/api';
const socketUrl = process.env.DM_E2E_SOCKET_URL || 'http://localhost:3000/chat';

const hasRequiredEnv = Boolean(
  isRealE2ERequested &&
    userAEmail &&
    userAPassword &&
    userBEmail &&
    userBPassword &&
    userBUsername &&
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_ANON_KEY,
);

describe('Real Direct Messages E2E Integration (Live Backend & Dedicated Test Accounts)', () => {
  if (!hasRequiredEnv) {
    it.skip('Skipped: Yêu cầu RUN_REAL_DM_E2E=true và cung cấp đủ DM_E2E_USER_A_EMAIL, DM_E2E_USER_A_PASSWORD, DM_E2E_USER_B_EMAIL, DM_E2E_USER_B_PASSWORD, DM_E2E_USER_B_USERNAME cùng SUPABASE_URL, SUPABASE_ANON_KEY', () => {});
    return;
  }

  const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const activeSockets: Socket[] = [];
  let socketA: Socket | null = null;
  let socketB: Socket | null = null;
  let jwtA: string;
  let jwtB: string;
  let userAId: string;
  let userBId: string;
  let conversationId: string;
  let messageId: string | null = null;

  // Helper quản lý socket tự động cleanup
  function registerSocket(socket: Socket): Socket {
    activeSockets.push(socket);
    return socket;
  }

  // Helper chờ sự kiện Socket với Timeout
  function waitForEvent<T = any>(
    socket: Socket,
    eventName: string,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(eventName, handler);
        reject(new Error(`Timeout (${timeoutMs}ms) khi chờ sự kiện '${eventName}'`));
      }, timeoutMs);

      const handler = (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      };

      socket.once(eventName, handler);
    });
  }

  // Helper emit có Acknowledgment và Timeout
  function emitWithAck<T = any>(
    socket: Socket,
    event: string,
    data: any,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout (${timeoutMs}ms) khi chờ ack sự kiện '${event}'`));
      }, timeoutMs);

      socket.emit(event, data, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  // Helper đếm chính xác số lượng event nhận được trong quiet window
  function collectEvents<T = any>(
    socket: Socket,
    eventName: string,
    quietWindowMs = 500,
    timeoutMs = 5000,
  ): { promise: Promise<T[]>; cancel: () => void } {
    let collected: T[] = [];
    let resolvePromise: (val: T[]) => void;
    let rejectPromise: (err: Error) => void;
    let quietTimer: NodeJS.Timeout | null = null;
    let maxTimer: NodeJS.Timeout | null = null;

    const handler = (payload: T) => {
      collected.push(payload);
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolvePromise(collected);
      }, quietWindowMs);
    };

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (maxTimer) clearTimeout(maxTimer);
      socket.off(eventName, handler);
    };

    const promise = new Promise<T[]>((res, rej) => {
      resolvePromise = res;
      rejectPromise = rej;
      maxTimer = setTimeout(() => {
        cleanup();
        if (collected.length > 0) {
          res(collected);
        } else {
          rej(new Error(`Timeout (${timeoutMs}ms) không nhận được sự kiện '${eventName}'`));
        }
      }, timeoutMs);
      socket.on(eventName, handler);
    });

    return { promise, cancel: cleanup };
  }

  // Helper đảm bảo quan hệ bạn bè giữa User A và User B một cách idempotent
  async function ensureFriendship(tokenA: string, tokenB: string, targetBUsername: string, targetBId: string, targetAId: string) {
    // 1. Kiểm tra danh sách bạn bè hiện tại của A
    const listRes1 = await fetch(`${apiUrl}/friends`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    if (!listRes1.ok) {
      const errText = await listRes1.text();
      throw new Error(`Kiểm tra danh sách bạn bè của A thất bại (HTTP ${listRes1.status}): ${errText}`);
    }
    const friends1 = await listRes1.json();
    if (Array.isArray(friends1) && friends1.some((f: any) => f.id === targetBId)) {
      return; // Đã là bạn bè
    }

    // 2a. Kiểm tra incoming requests của B (A đã gửi trước đó chưa)
    const reqBRes = await fetch(`${apiUrl}/friends/requests`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    if (!reqBRes.ok) {
      const errText = await reqBRes.text();
      throw new Error(`Lấy danh sách lời mời của B thất bại (HTTP ${reqBRes.status}): ${errText}`);
    }
    const requestsB = await reqBRes.json();
    const incomingBFromA = Array.isArray(requestsB?.incoming)
      ? requestsB.incoming.find((r: any) => r.id === targetAId)
      : null;

    if (incomingBFromA) {
      const acceptRes = await fetch(`${apiUrl}/friends/requests/${targetAId}/accept`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      if (!acceptRes.ok) {
        const errText = await acceptRes.text();
        throw new Error(`B chấp nhận lời mời từ A thất bại (HTTP ${acceptRes.status}): ${errText}`);
      }
    } else {
      // 2b. Kiểm tra incoming requests của A (B đã gửi trước đó chưa)
      const reqARes = await fetch(`${apiUrl}/friends/requests`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      if (!reqARes.ok) {
        const errText = await reqARes.text();
        throw new Error(`Lấy danh sách lời mời của A thất bại (HTTP ${reqARes.status}): ${errText}`);
      }
      const requestsA = await reqARes.json();
      const incomingAFromB = Array.isArray(requestsA?.incoming)
        ? requestsA.incoming.find((r: any) => r.id === targetBId)
        : null;

      if (incomingAFromB) {
        const acceptRes = await fetch(`${apiUrl}/friends/requests/${targetBId}/accept`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokenA}` },
        });
        if (!acceptRes.ok) {
          const errText = await acceptRes.text();
          throw new Error(`A chấp nhận lời mời từ B thất bại (HTTP ${acceptRes.status}): ${errText}`);
        }
      } else {
        // 2c. Cả hai chưa gửi lời mời -> A gửi lời mời kết bạn cho B bằng username
        const sendReqRes = await fetch(`${apiUrl}/friends/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenA}`,
          },
          body: JSON.stringify({ username: targetBUsername }),
        });
        if (!sendReqRes.ok && sendReqRes.status !== 409) {
          const errText = await sendReqRes.text();
          throw new Error(`A gửi lời mời kết bạn cho B thất bại (HTTP ${sendReqRes.status}): ${errText}`);
        }

        // B tải lại incoming requests và accept
        const reqBReloadRes = await fetch(`${apiUrl}/friends/requests`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        if (!reqBReloadRes.ok) {
          const errText = await reqBReloadRes.text();
          throw new Error(`B tải lại lời mời thất bại (HTTP ${reqBReloadRes.status}): ${errText}`);
        }
        const reloadedB = await reqBReloadRes.json();
        const found = Array.isArray(reloadedB?.incoming)
          ? reloadedB.incoming.find((r: any) => r.id === targetAId)
          : null;

        if (!found) {
          throw new Error(`B không tìm thấy lời mời kết bạn vừa gửi từ A (requesterId: ${targetAId})`);
        }

        const acceptRes = await fetch(`${apiUrl}/friends/requests/${targetAId}/accept`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        if (!acceptRes.ok) {
          const errText = await acceptRes.text();
          throw new Error(`B chấp nhận lời mời kết bạn thất bại (HTTP ${acceptRes.status}): ${errText}`);
        }
      }
    }

    // 3. Xác minh cuối cùng: A phải thấy B trong danh sách bạn bè
    const listRes2 = await fetch(`${apiUrl}/friends`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    if (!listRes2.ok) {
      const errText = await listRes2.text();
      throw new Error(`Kiểm tra danh sách bạn bè lần 2 thất bại (HTTP ${listRes2.status}): ${errText}`);
    }
    const friends2 = await listRes2.json();
    const isNowFriend = Array.isArray(friends2) && friends2.some((f: any) => f.id === targetBId);
    if (!isNowFriend) {
      throw new Error(`Prerequisite bạn bè thất bại: User B (${targetBId}) không xuất hiện trong friends list của User A`);
    }
  }

  beforeAll(async () => {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

    const clientA = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const clientB = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [authA, authB] = await Promise.all([
      clientA.auth.signInWithPassword({
        email: userAEmail!,
        password: userAPassword!,
      }),
      clientB.auth.signInWithPassword({
        email: userBEmail!,
        password: userBPassword!,
      }),
    ]);

    if (authA.error || !authA.data.session) {
      throw new Error(`Đăng nhập Test User A thất bại: ${authA.error?.message}`);
    }
    if (authB.error || !authB.data.session) {
      throw new Error(`Đăng nhập Test User B thất bại: ${authB.error?.message}`);
    }

    jwtA = authA.data.session.access_token;
    jwtB = authB.data.session.access_token;
    userAId = authA.data.user.id;
    userBId = authB.data.user.id;

    // Prerequisite: Thiết lập quan hệ bạn bè idempotent hoàn chỉnh
    await ensureFriendship(jwtA, jwtB, userBUsername!, userBId, userAId);
  }, 25000);

  afterAll(async () => {
    // 1. Dọn dẹp toàn bộ Socket.IO clients đã tạo
    for (const socket of activeSockets) {
      try {
        socket.removeAllListeners();
        socket.disconnect();
      } catch {
        // Ignore teardown errors
      }
    }

    // 2. Scoped cleanup: Chỉ xóa message của đúng runId này
    if (messageId && jwtA) {
      try {
        await fetch(`${apiUrl}/messages/${messageId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${jwtA}` },
        });
      } catch {
        // Ignore cleanup failure in afterAll
      }
    }
  });

  it('1. User A tạo/lấy DM với User B qua POST /api/conversations/dm', async () => {
    const res = await fetch(`${apiUrl}/conversations/dm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({ recipientId: userBId }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    conversationId = data.id;
  });

  it('2. Cả 2 socket kết nối bằng JWT token thật và join room conversation với ack timeout', async () => {
    socketA = registerSocket(
      io(socketUrl, {
        auth: { token: jwtA },
        transports: ['websocket'],
      }),
    );
    socketB = registerSocket(
      io(socketUrl, {
        auth: { token: jwtB },
        transports: ['websocket'],
      }),
    );

    await Promise.all([
      waitForEvent(socketA, 'connect', 5000),
      waitForEvent(socketB, 'connect', 5000),
    ]);

    expect(socketA.connected).toBe(true);
    expect(socketB.connected).toBe(true);

    const [joinResA, joinResB] = await Promise.all([
      emitWithAck<{ success: boolean; status?: string }>(
        socketA,
        'conversation:join',
        { conversationId },
        5000,
      ),
      emitWithAck<{ success: boolean; status?: string }>(
        socketB,
        'conversation:join',
        { conversationId },
        5000,
      ),
    ]);

    expect(joinResA.success).toBe(true);
    expect(joinResB.success).toBe(true);
  });

  it('3. User A gửi tin nhắn qua REST -> User B nhận đúng duy nhất một message:created', async () => {
    // clientNonce bắt buộc là UUID v4 hợp lệ theo SendMessageDto
    const clientNonce = crypto.randomUUID();
    const messageContent = `[${runId}] Xin chào B từ A (Real E2E Test)`;

    const collector = collectEvents(socketB!, 'message:created', 500, 6000);

    const sendRes = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({
        content: messageContent,
        clientNonce,
      }),
    });

    expect(sendRes.status).toBe(201);
    const sendData = await sendRes.json();
    messageId = sendData.id;

    const events = await collector.promise;
    // Khẳng định nhận ĐÚNG MỘT lần trong quiet window
    expect(events.length).toBe(1);
    expect(events[0].message.id).toBe(messageId);
    expect(events[0].message.content).toBe(messageContent);
    expect(events[0].message.conversationId).toBe(conversationId);
  });

  it('4. User A gõ phím -> User B nhận typing:updated', async () => {
    const typingPromise = waitForEvent(socketB!, 'typing:updated', 5000);

    socketA!.emit('typing:start', { conversationId });

    const payload = await typingPromise;
    expect(payload.conversationId).toBe(conversationId);
    expect(payload.userIds).toContain(userAId);

    // Gửi typing:stop
    socketA!.emit('typing:stop', { conversationId });
  });

  it('5. User A sửa tin nhắn qua REST -> User B nhận message:updated', async () => {
    const updatedContent = `[${runId}] Nội dung Real E2E đã sửa`;
    const updatePromise = waitForEvent(socketB!, 'message:updated', 5000);

    const editRes = await fetch(`${apiUrl}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({
        content: updatedContent,
      }),
    });

    expect(editRes.ok).toBe(true);
    const updated = await updatePromise;
    expect(updated.message.content).toBe(updatedContent);
    expect(updated.message.id).toBe(messageId);
  });

  it('6. User B đánh dấu đã đọc qua REST -> User A nhận message:read', async () => {
    const readPromise = waitForEvent(socketA!, 'message:read', 5000);

    const readRes = await fetch(`${apiUrl}/conversations/${conversationId}/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtB}`,
      },
      body: JSON.stringify({ messageId }),
    });

    expect(readRes.ok).toBe(true);
    const readPayload = await readPromise;
    expect(readPayload.conversationId).toBe(conversationId);
    expect(readPayload.userId).toBe(userBId);
    expect(readPayload.lastReadMessageId).toBe(messageId);
  });

  it('7. User A xoá tin nhắn qua REST -> User B nhận message:deleted', async () => {
    const deletePromise = waitForEvent(socketB!, 'message:deleted', 5000);

    const deleteRes = await fetch(`${apiUrl}/messages/${messageId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${jwtA}`,
      },
    });

    expect(deleteRes.ok).toBe(true);
    const deleted = await deletePromise;
    expect(deleted.messageId).toBe(messageId);
  });

  it('8. Manual rejoin after reconnect (User B ngắt kết nối và kết nối lại)', async () => {
    socketB!.disconnect();

    const reconnectSocketB = registerSocket(
      io(socketUrl, {
        auth: { token: jwtB },
        transports: ['websocket'],
      }),
    );

    await waitForEvent(reconnectSocketB, 'connect', 5000);

    const joinRes = await emitWithAck<{ success: boolean }>(
      reconnectSocketB,
      'conversation:join',
      { conversationId },
      5000,
    );

    expect(joinRes.success).toBe(true);

    const reconnectMessagePromise = waitForEvent(reconnectSocketB, 'message:created', 5000);
    const reconnectContent = `[${runId}] Tin nhắn kiểm tra sau khi reconnect`;

    const res = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtA}`,
      },
      body: JSON.stringify({
        content: reconnectContent,
      }),
    });

    expect(res.ok).toBe(true);
    const reconnectCreated = await res.json();

    const received = await reconnectMessagePromise;
    expect(received.message.content).toBe(reconnectContent);

    // Dọn dẹp tin nhắn kiểm tra
    if (reconnectCreated?.id) {
      await fetch(`${apiUrl}/messages/${reconnectCreated.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwtA}` },
      });
    }

    reconnectSocketB.disconnect();
  });
});
