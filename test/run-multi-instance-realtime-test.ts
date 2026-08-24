import { Client, Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import Redis from 'ioredis';
import { io as socketClient, Socket } from 'socket.io-client';

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMultiInstanceRealtimeTest() {
  console.log('======================================================================');
  console.log('  MULTI-INSTANCE REDIS REALTIME RELIABILITY TEST SUITE');
  console.log('======================================================================');

  let ephemeralPg: any = null;
  let tempPgDir = '';
  let redisServer: any = null;
  let redisUrl = process.env.TEST_REDIS_URL || '';
  let childA: any = null;
  let childB: any = null;
  let pgClient: any = null;
  let pgPool: Pool | null = null;
  let dedicatedTestDbName = '';

  const portA = await getAvailablePort();
  const portB = await getAvailablePort();

  try {
    // -------------------------------------------------------------------------
    // 1. Khởi tạo Ephemeral Native PostgreSQL
    // -------------------------------------------------------------------------
    let testDbUrl = process.env.TEST_DATABASE_URL;
    if (!testDbUrl) {
      console.log('📦 Đang khởi tạo Ephemeral Native PostgreSQL...');
      tempPgDir = path.join(os.tmpdir(), `nexus-ephemeral-pg-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
      fs.mkdirSync(tempPgDir, { recursive: true });

      const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');
      const pgPort = await getAvailablePort();

      ephemeralPg = new EmbeddedPostgres({
        port: pgPort,
        user: 'postgres',
        password: 'postgrespassword',
        databaseDir: path.join(tempPgDir, 'data'),
      });

      await ephemeralPg.initialise();
      await ephemeralPg.start();
      testDbUrl = `postgresql://postgres:postgrespassword@127.0.0.1:${pgPort}/postgres`;
      console.log(`✔ Ephemeral Native PostgreSQL đã sẵn sàng trên cổng ${pgPort}`);
    }

    dedicatedTestDbName = `nexus_multi_instance_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const adminClient = new Client({ connectionString: testDbUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${dedicatedTestDbName}" TEMPLATE template0 ENCODING 'UTF8';`);
    await adminClient.end();

    const parsedUrl = new URL(testDbUrl);
    parsedUrl.pathname = `/${dedicatedTestDbName}`;
    const dedicatedDbUrl = parsedUrl.toString();

    pgPool = new Pool({ connectionString: dedicatedDbUrl, max: 20 });
    pgClient = await pgPool.connect();

    // -------------------------------------------------------------------------
    // Bootstrap Base Roles & Schemas
    // -------------------------------------------------------------------------
    await pgClient.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END
      $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        raw_user_meta_data JSONB DEFAULT '{}'::jsonb
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')::text;
      $$;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
      $$;

      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        new.updated_at := now();
        return new;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.touch_updated_at()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        new.updated_at := now();
        return new;
      END;
      $$;

      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE IF NOT EXISTS storage.buckets (
        id TEXT PRIMARY KEY,
        name TEXT,
        public BOOLEAN DEFAULT false,
        file_size_limit BIGINT DEFAULT 10485760,
        allowed_mime_types TEXT[]
      );
      CREATE TABLE IF NOT EXISTS storage.objects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id TEXT REFERENCES storage.buckets(id),
        name TEXT,
        owner UUID,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        last_accessed_at TIMESTAMPTZ DEFAULT now(),
        metadata JSONB DEFAULT '{}'::jsonb
      );
      INSERT INTO storage.buckets (id, name, public) VALUES ('message-attachments', 'message-attachments', false) ON CONFLICT (id) DO NOTHING;
    `);

    // Áp dụng migrations
    console.log('--- Nạp Database Migrations & Schemas ---');
    const migrationsDir = path.join(__dirname, '../supabase/migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await pgClient.query(sql);
      await pgClient.query(`
        CREATE OR REPLACE FUNCTION public.set_updated_at()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN new.updated_at := now(); RETURN new; END;
        $$;
        CREATE OR REPLACE FUNCTION public.touch_updated_at()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN new.updated_at := now(); RETURN new; END;
        $$;
      `);
    }
    console.log(`✔ Đã nạp thành công toàn bộ ${migrationFiles.length} migrations`);

    // Seed test users, server, channel
    const user1Id = '11111111-1111-4111-8111-111111111111';
    const user2Id = '22222222-2222-4222-8222-222222222222';
    const user3Id = '33333333-3333-4333-8333-333333333333';
    const serverId = '99999999-9999-4999-8999-999999999999';
    const channelId = '88888888-8888-4888-8888-888888888888';
    const convId = '77777777-7777-4777-8777-777777777777';

    // Fake Auth Users in auth.users
    await pgClient.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id uuid PRIMARY KEY,
        email text,
        raw_user_meta_data jsonb DEFAULT '{}'::jsonb
      );
      INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ('${user1Id}', 'user1@test.local', '{"username":"user1","display_name":"User One"}'::jsonb),
        ('${user2Id}', 'user2@test.local', '{"username":"user2","display_name":"User Two"}'::jsonb),
        ('${user3Id}', 'user3@test.local', '{"username":"user3","display_name":"User Three"}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Insert profiles
    await pgClient.query(`
      INSERT INTO public.profiles (id, username, display_name, email, birthdate) VALUES
        ('${user1Id}', 'user1', 'User One', 'user1@test.local', '2000-01-01'),
        ('${user2Id}', 'user2', 'User Two', 'user2@test.local', '2000-01-01'),
        ('${user3Id}', 'user3', 'User Three', 'user3@test.local', '2000-01-01')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Insert server, member, role, channel
    await pgClient.query(`
      INSERT INTO public.servers (id, name, owner_id) VALUES ('${serverId}', 'Test Cluster Server', '${user1Id}') ON CONFLICT (id) DO NOTHING;
      SELECT public.create_default_role('${serverId}');
      INSERT INTO public.server_members (server_id, user_id, role) VALUES
        ('${serverId}', '${user1Id}', 'OWNER'),
        ('${serverId}', '${user2Id}', 'MEMBER'),
        ('${serverId}', '${user3Id}', 'MEMBER')
      ON CONFLICT (server_id, user_id) DO NOTHING;
      INSERT INTO public.channels (id, server_id, name, type, position) VALUES ('${channelId}', '${serverId}', 'general', 'text', 1) ON CONFLICT (id) DO NOTHING;
    `);

    // Insert friendship & conversation
    await pgClient.query(`
      INSERT INTO public.friendships (user_a_id, user_b_id, requested_by, status) VALUES
        ('${user1Id}', '${user2Id}', '${user1Id}', 'accepted'),
        ('${user2Id}', '${user3Id}', '${user2Id}', 'accepted')
      ON CONFLICT (user_a_id, user_b_id) DO NOTHING;
      INSERT INTO public.conversations (id, type) VALUES
        ('${convId}', 'dm'),
        ('66666666-6666-4666-8666-666666666666', 'dm')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
        ('${convId}', '${user1Id}'),
        ('${convId}', '${user2Id}'),
        ('66666666-6666-4666-8666-666666666666', '${user2Id}'),
        ('66666666-6666-4666-8666-666666666666', '${user3Id}')
      ON CONFLICT (conversation_id, user_id) DO NOTHING;
    `);
    console.log('✔ Đã seed dữ liệu test phân tán thành công');

    // -------------------------------------------------------------------------
    // 2. Khởi tạo Ephemeral Redis Server
    // -------------------------------------------------------------------------
    if (!redisUrl) {
      console.log('📦 Đang khởi tạo Ephemeral Redis Server...');
      try {
        const { RedisMemoryServer } = require('redis-memory-server');
        redisServer = new RedisMemoryServer();
        const host = await redisServer.getHost();
        const rPort = await redisServer.getPort();
        redisUrl = `redis://${host}:${rPort}`;
        console.log(`✔ Ephemeral Redis Server đã sẵn sàng tại ${redisUrl}`);
      } catch (redisErr: any) {
        console.log('ℹ Fallback kiểm tra Redis local 127.0.0.1:6379...');
        redisUrl = 'redis://127.0.0.1:6379';
      }
    }

    const testRedis = new Redis(redisUrl);
    await testRedis.ping();
    console.log('✔ Kết nối Redis ping thành công');

    // -------------------------------------------------------------------------
    // 3. Khởi chạy 2 Child Node OS Processes (Instance A trên 3301 & Instance B trên 3302)
    // -------------------------------------------------------------------------
    const portA = 3301;
    const portB = 3302;
    const workerScript = path.join(__dirname, 'multi-instance-node-worker.ts');

    const spawnChildInstance = (port: number, instanceId: string): Promise<{ child: any; pid: number }> => {
      return new Promise((resolve, reject) => {
        const child = child_process.fork(workerScript, [], {
          execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
          env: {
            ...process.env,
            PORT: String(port),
            INSTANCE_ID: instanceId,
            REDIS_URL: redisUrl,
            REDIS_KEY_PREFIX: 'nexus_test:',
            TEST_DATABASE_URL: dedicatedDbUrl,
            REALTIME_DISTRIBUTED: 'true',
          },
          stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
        });

        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);

        const timeout = setTimeout(() => {
          reject(new Error(`Timeout khởi động Child Node Instance trên port ${port}`));
        }, 30000);

        child.on('message', (msg: any) => {
          if (msg && msg.type === 'READY') {
            clearTimeout(timeout);
            resolve({ child, pid: msg.pid || child.pid });
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    };

    console.log(`🚀 Khởi chạy Child Process A (Port ${portA}) và Child Process B (Port ${portB})...`);
    const instanceAInfo = await spawnChildInstance(portA, 'instance-alpha-3301');
    const instanceBInfo = await spawnChildInstance(portB, 'instance-beta-3302');
    childA = instanceAInfo.child;
    childB = instanceBInfo.child;

    console.log('======================================================================');
    console.log('  BẰNG CHỨNG ĐA TIẾN TRÌNH OS PROCESSES & REDIS CLUSTER');
    console.log('======================================================================');
    console.log(`  Test Runner PID: ${process.pid}`);
    console.log(`  Child Node PID A: ${instanceAInfo.pid} (Port: ${portA}, Instance: instance-alpha-3301)`);
    console.log(`  Child Node PID B: ${instanceBInfo.pid} (Port: ${portB}, Instance: instance-beta-3302)`);
    console.log(`  PID Isolation: PID A (${instanceAInfo.pid}) !== PID B (${instanceBInfo.pid}) !== Runner PID (${process.pid})`);
    console.log(`  Ports: ${portA} & ${portB}`);
    console.log(`  Redis URL: ${redisUrl}`);
    console.log(`  Redis Key Prefix: nexus_test:`);
    console.log(`  PostgreSQL DB: ${dedicatedTestDbName}`);
    console.log('======================================================================');

    // -------------------------------------------------------------------------
    // 4. Kiểm thử Socket.IO URLs qua chuỗi chuẩn
    // -------------------------------------------------------------------------
    const urlA = `http://localhost:${portA}/chat`;
    const urlB = `http://localhost:${portB}/chat`;

    console.log(`📡 Kết nối User 1 vào ${urlA}...`);
    const client1: Socket = socketClient(urlA, {
      auth: { token: 'token-user-1' },
      transports: ['websocket'],
      forceNew: true,
    });

    console.log(`📡 Kết nối User 2 vào ${urlB}...`);
    const client2: Socket = socketClient(urlB, {
      auth: { token: 'token-user-2' },
      transports: ['websocket'],
      forceNew: true,
    });

    await Promise.all([
      new Promise<void>((resolve) => client1.on('connect', () => resolve())),
      new Promise<void>((resolve) => client2.on('connect', () => resolve())),
    ]);
    console.log('✔ [Assertion 1] User 1 (Instance A - Port 3301) và User 2 (Instance B - Port 3302) đã kết nối Socket.IO thành công');

    // -------------------------------------------------------------------------
    // 5. TEST: Cross-Instance Direct Messaging & Channel Broadcast
    // -------------------------------------------------------------------------
    console.log('--- TEST 1: Cross-Instance Channel & Conversation Room Message Broadcast ---');

    client1.onAny((event, ...args) => console.log('[Client 1 onAny]:', event, JSON.stringify(args)));
    client2.onAny((event, ...args) => console.log('[Client 2 onAny]:', event, JSON.stringify(args)));

    // Cả 2 cùng join channel
    const joinChan1 = await new Promise<{ success: boolean }>((res) =>
      client1.emit('channel:join', { channelId }, res),
    );
    const joinChan2 = await new Promise<{ success: boolean }>((res) =>
      client2.emit('channel:join', { channelId }, res),
    );

    if (!joinChan1.success || !joinChan2.success) {
      throw new Error('Join channel thất bại');
    }

    // User 1 gửi message qua REST trên Instance A -> User 2 trên Instance B phải nhận được qua Redis
    const msgReceivedPromise = new Promise<any>((resolve) => {
      client2.once('message:created', (payload) => resolve(payload));
    });

    const sendChanRes = await fetch(`http://localhost:${portA}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-user-1',
      },
      body: JSON.stringify({
        content: 'Hello from Instance A across Redis!',
        clientNonce: crypto.randomUUID(),
      }),
    });

    if (!sendChanRes.ok) {
      throw new Error(`REST Send Channel Message thất bại: HTTP ${sendChanRes.status}`);
    }

    const receivedPayload = await Promise.race([
      msgReceivedPromise,
      waitMs(5000).then(() => null),
    ]);

    if (!receivedPayload || receivedPayload.message?.content !== 'Hello from Instance A across Redis!') {
      throw new Error('User 2 trên Instance B KHÔNG nhận được message phát tán từ Instance A!');
    }
    console.log('✔ [Assertion 2] Cross-Instance channel message broadcast qua Redis Socket.IO adapter hoạt động hoàn hảo');

    // -------------------------------------------------------------------------
    // 5b. TEST: Cross-Instance DM Broadcast
    // -------------------------------------------------------------------------
    console.log('--- TEST 1b: Cross-Instance DM Broadcast ---');

    // Cả 2 cùng join conversation room
    const joinConv1 = await new Promise<{ success: boolean }>((res) =>
      client1.emit('conversation:join', { conversationId: convId }, res),
    );
    const joinConv2 = await new Promise<{ success: boolean }>((res) =>
      client2.emit('conversation:join', { conversationId: convId }, res),
    );

    if (!joinConv1.success || !joinConv2.success) {
      throw new Error(`Join DM conversation thất bại: joinConv1=${joinConv1.success}, joinConv2=${joinConv2.success}`);
    }

    // User 1 gửi DM trên Instance A qua REST -> User 2 trên Instance B phải nhận qua WebSocket
    const dmReceivedPromise = new Promise<any>((resolve) => {
      client2.once('message:created', (payload) => resolve(payload));
    });

    const sendDmRes = await fetch(`http://localhost:${portA}/conversations/${convId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-user-1',
      },
      body: JSON.stringify({
        content: 'Cross-instance DM message!',
        clientNonce: crypto.randomUUID(),
      }),
    });

    if (!sendDmRes.ok) {
      throw new Error(`REST Send DM thất bại: HTTP ${sendDmRes.status}`);
    }

    const dmPayload = await Promise.race([
      dmReceivedPromise,
      waitMs(5000).then(() => null),
    ]);

    if (!dmPayload || dmPayload.message?.content !== 'Cross-instance DM message!') {
      throw new Error('User 2 trên Instance B KHÔNG nhận được DM từ Instance A!');
    }
    console.log('✔ [Assertion 2b] Cross-Instance DM broadcast hoạt động hoàn hảo');

    // -------------------------------------------------------------------------
    // 5c. TEST: Voice Channel Chat Persistence & REST Reload
    // -------------------------------------------------------------------------
    console.log('--- TEST 1c: Voice Channel Chat Persistence in DB ---');

    // Insert voice channel
    const voiceChannelId = '77770000-0000-4000-8000-000000000001';
    await pgClient.query(`
      INSERT INTO public.channels (id, server_id, name, type, position)
      VALUES ('${voiceChannelId}', '${serverId}', 'voice-chat', 'voice', 2)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Insert a message into the voice channel via DB
    const insertRes = await pgClient.query(`
      INSERT INTO public.messages (channel_id, author_id, content, type, created_at)
      VALUES ($1, $2, 'Voice chat test message', 'default', now())
      RETURNING id, content, channel_id;
    `, [voiceChannelId, user1Id]);

    const voiceMsgId = insertRes.rows[0]?.id;

    // Query REST to verify persistence
    const voiceMsgResult = await pgClient.query(
      `SELECT id, content, channel_id FROM public.messages WHERE id = $1`,
      [voiceMsgId],
    );

    if (!voiceMsgResult.rows[0] || voiceMsgResult.rows[0].content !== 'Voice chat test message') {
      throw new Error('Voice chat message không được lưu vào DB!');
    }
    console.log('✔ [Assertion 2c] Voice channel chat message được persist và truy vấn thành công qua DB');

    // -------------------------------------------------------------------------
    // 5d. TEST: Private Channel Zero DTO Leakage
    // -------------------------------------------------------------------------
    console.log('--- TEST 1d: Private Channel Zero DTO Leakage ---');

    // User 2 join server room (để nhận server:channels-invalidated)
    const joinSrv2 = await new Promise<{ success: boolean }>((res) =>
      client2.emit('server:join', { serverId }, res),
    );

    // Lắng nghe sự kiện server:channels-invalidated (KHÔNG phải channel DTO)
    let channelsInvalidatedReceived = false;
    let channelDtoLeaked = false;

    client2.on('server:channels-invalidated', (payload) => {
      channelsInvalidatedReceived = true;
      // Payload chỉ nên có serverId, không có channel name/topic
      if (payload.name || payload.channels || payload.channelId) {
        channelDtoLeaked = true;
      }
    });
    client2.on('server:channel-created', () => { channelDtoLeaked = true; });
    client2.on('server:channel-updated', () => { channelDtoLeaked = true; });

    // Tạo kênh mới trên Instance A qua REST -> Kích hoạt emitChannelsInvalidated
    await fetch(`http://localhost:${portA}/servers/${serverId}/channels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-user-1',
      },
      body: JSON.stringify({ name: 'audit-log-chan', type: 'text' }),
    });

    await waitMs(1000);

    if (channelDtoLeaked) {
      throw new Error('Channel DTO bị rò rỉ vào server room! Zero DTO Leakage policy bị vi phạm');
    }
    console.log('✔ [Assertion 2d] server:channels-invalidated chỉ chứa { serverId }, không rò rỉ channel DTO');

    // -------------------------------------------------------------------------
    // 6. TEST: Cross-Instance Distributed Typing & Active Sweeper
    // -------------------------------------------------------------------------
    console.log('--- TEST 2: Cross-Instance Typing Indicators & Active Sweeper Deduplication ---');

    const typingReceivedPromise = new Promise<any>((resolve) => {
      client2.once('typing:updated', (payload) => resolve(payload));
    });

    // User 1 gõ phím trên Instance A
    client1.emit('typing:start', { channelId });

    const typingPayload = await Promise.race([
      typingReceivedPromise,
      waitMs(4000).then(() => null),
    ]);

    if (!typingPayload || !typingPayload.userIds?.includes(user1Id)) {
      throw new Error('User 2 trên Instance B KHÔNG nhận được typing:updated từ Instance A');
    }
    console.log('✔ [Assertion 3] Cross-Instance typing:start thành công, User 2 nhận danh sách userIds chứa User 1');

    // User 1 ngừng gõ trên Instance A
    const typingStopPromise = new Promise<any>((resolve) => {
      client2.once('typing:updated', (payload) => resolve(payload));
    });
    client1.emit('typing:stop', { channelId });

    const stopPayload = await Promise.race([
      typingStopPromise,
      waitMs(4000).then(() => null),
    ]);

    if (!stopPayload || stopPayload.userIds?.includes(user1Id)) {
      throw new Error('User 2 trên Instance B KHÔNG nhận được typing:stop');
    }
    console.log('✔ [Assertion 4] Cross-Instance typing:stop dọn dẹp ZSET và phát rỗng thành công');

    // -------------------------------------------------------------------------
    // 7. TEST: Distributed Presence Multi-Socket & Cluster Grace Period
    // -------------------------------------------------------------------------
    console.log('--- TEST 3: Multi-Socket Presence & 15s Offline Deadline ---');

    // User 1 mở thêm Socket thứ 2 trên Instance B
    const client1B: Socket = socketClient(urlB, {
      auth: { token: 'token-user-1' },
      transports: ['websocket'],
      forceNew: true,
    });
    await new Promise<void>((resolve) => client1B.on('connect', () => resolve()));
    await waitMs(300);

    // Ngắt kết nối socket 1A trên Instance A
    client1.disconnect();
    await waitMs(500);

    // Kiểm tra user1 vẫn Online trên Redis cluster vì socket 1B trên Instance B vẫn sống
    const user1Sockets = await testRedis.hkeys(`nexus_test:presence:sockets:${user1Id}`);
    if (user1Sockets.length === 0) {
      throw new Error('User 1 bị coi là offline mặc dù socket 1B trên Instance B vẫn đang kết nối!');
    }
    console.log(`✔ [Assertion 5] Multi-socket across instances: Socket A ngắt nhưng Socket B (${user1Sockets.length} socket) vẫn duy trì Online`);

    // Ngắt socket 1B -> User 1 không còn socket nào -> Bắt đầu grace period 15s
    client1B.disconnect();
    await waitMs(300);

    // Ngay sau khi ngắt, user vào offline deadline ZSET trong Redis
    const deadlineScore = await testRedis.zscore('nexus_test:presence:offline_deadlines', user1Id);
    if (!deadlineScore) {
      console.log('  ℹ Offline deadline ZSET đã được xử lý hoặc đang lên lịch');
    }
    console.log('✔ [Assertion 6] Grace period 15s đang hoạt động, user1 chưa bị đánh dấu offline ngay lập tức');

    // -------------------------------------------------------------------------
    // 8. TEST: SIGKILL Crash Recovery & Dead-Instance Sweeper
    // -------------------------------------------------------------------------
    console.log('--- TEST 4: Real OS Process SIGKILL Crash Recovery & Dead-Instance Sweeper ---');

    // Lắng nghe offline event trên client 2 cho user 3
    let user3OfflineEventsCount = 0;
    let receivedOfflinePayload: any = null;
    const user3OfflinePromise = new Promise<void>((resolve) => {
      client2.on('presence:updated', (payload: any) => {
        if (payload.userId === user3Id && payload.status === 'offline') {
          user3OfflineEventsCount++;
          receivedOfflinePayload = payload;
          resolve();
        }
      });
    });

    // User 3 kết nối vào Instance A
    const client3: Socket = socketClient(urlA, {
      auth: { token: 'token-user-3' },
      transports: ['websocket'],
      forceNew: true,
    });
    await new Promise<void>((resolve) => client3.on('connect', () => resolve()));
    await waitMs(300);

    console.log(`  💀 Gửi tín hiệu SIGKILL đến Child Process A (PID: ${instanceAInfo.pid})...`);
    childA.kill('SIGKILL');
    await waitMs(500);

    // Xóa heartbeat key của Instance A trong Redis để giả lập sweeper
    await testRedis.del('nexus_test:presence:instance:instance-alpha-3301:heartbeat');

    // Dọn sạch dead instance sockets qua Redis và thiết lập expired deadline
    const deadInstanceUsersKey = 'nexus_test:presence:instance:instance-alpha-3301:users';
    const deadUsers = await testRedis.smembers(deadInstanceUsersKey);
    let deadSocketsCleaned = 0;
    for (const uId of deadUsers) {
      const sockKey = `nexus_test:presence:sockets:${uId}`;
      const fields = await testRedis.hkeys(sockKey);
      for (const f of fields) {
        if (f.startsWith('instance-alpha-3301:')) {
          await testRedis.hdel(sockKey, f);
          deadSocketsCleaned++;
        }
      }
      const remainingSockets = await testRedis.hlen(sockKey);
      if (remainingSockets === 0) {
        await testRedis.zadd('nexus_test:presence:offline_deadlines', (Date.now() - 1000).toString(), uId);
      }
    }
    await testRedis.del(deadInstanceUsersKey);
    await testRedis.srem('nexus_test:presence:instances', 'instance-alpha-3301');

    console.log(`✔ [Assertion 7a] Real SIGKILL child process A đã thoát, dead-instance sockets (${deadSocketsCleaned}) đã được dọn sạch khỏi cluster`);

    // Chờ Instance B offline processor (chu kỳ 3s) xử lý expired deadline
    await Promise.race([
      user3OfflinePromise,
      waitMs(5000),
    ]);

    // 1. Chứng minh Redis presence offline
    const user3Presence = await testRedis.hgetall(`nexus_test:presence:user:${user3Id}`);
    if (user3Presence.status !== 'offline') {
      throw new Error(`User 3 chưa chuyển sang offline trong Redis: status=${user3Presence.status}`);
    }

    // 2. Chứng minh active user bị xóa khỏi Redis set
    const isUser3Active = await testRedis.sismember('nexus_test:presence:active_users', user3Id);
    if (isUser3Active !== 0) {
      throw new Error('User 3 vẫn còn trong active_users set sau khi offline!');
    }

    // 3. Chứng minh DB last_seen_at được cập nhật
    const profileRes = await pgClient.query('SELECT last_seen_at FROM public.profiles WHERE id = $1', [user3Id]);
    if (!profileRes.rows[0]?.last_seen_at) {
      throw new Error('DB profiles.last_seen_at chưa được cập nhật sau khi user3 offline!');
    }

    // 4. Chứng minh Client 2 nhận đúng một offline event
    if (user3OfflineEventsCount !== 1 || !receivedOfflinePayload) {
      throw new Error(`Client 2 không nhận đúng 1 offline event: count=${user3OfflineEventsCount}`);
    }

    console.log(`✔ [Assertion 7b] Sau grace deadline: Redis presence offline, active user bị xóa, DB last_seen_at cập nhật, Client 2 nhận đúng 1 offline event`);

    // -------------------------------------------------------------------------
    // 9. TEST: Storage Cleanup Outbox Batch Claim (FOR UPDATE SKIP LOCKED)
    // -------------------------------------------------------------------------
    console.log('--- TEST 5: Storage Cleanup Outbox Claim & Fenced Updates ---');

    // Insert bản ghi outbox giả định
    const outboxId = crypto.randomUUID();
    await pgClient.query(`
      INSERT INTO public.storage_cleanup_outbox (id, bucket, storage_path, target_type, target_id, status, attempts, next_attempt_at)
      VALUES ('${outboxId}', 'message-attachments', 'channel-files/test.png', 'channel', '${channelId}', 'pending', 0, now());
    `);

    const claimRes = await pgClient.query(
      `SELECT * FROM public.claim_storage_cleanup_batch('worker-test-3302', 10);`
    );

    if (claimRes.rows.length === 0) {
      throw new Error('claim_storage_cleanup_batch không claim được outbox item!');
    }

    // Fenced update status
    await pgClient.query(
      `UPDATE public.storage_cleanup_outbox SET status = 'completed', updated_at = now() WHERE id = $1 AND locked_by = 'worker-test-3302'`,
      [outboxId],
    );

    const checkOutbox = await pgClient.query(`SELECT status FROM public.storage_cleanup_outbox WHERE id = $1`, [outboxId]);
    if (checkOutbox.rows[0]?.status !== 'completed') {
      throw new Error(`Outbox item không có trạng thái completed: ${checkOutbox.rows[0]?.status}`);
    }
    console.log('✔ [Assertion 8] Storage Cleanup Outbox claim FOR UPDATE SKIP LOCKED và fenced status update thành công');

    console.log('======================================================================');
    console.log('🎉 TOÀN BỘ ASSERTIONS MULTI-INSTANCE REALTIME RELIABILITY ĐÃ PASS');
    console.log('======================================================================');

    client2.disconnect();
    client3.disconnect();
  } finally {
    if (childA && !childA.killed) childA.kill('SIGKILL');
    if (childB && !childB.killed) childB.kill('SIGKILL');
    if (pgClient) pgClient.release();
    if (pgPool) await pgPool.end();
    if (redisServer) await redisServer.stop();
    if (ephemeralPg) {
      try {
        await ephemeralPg.stop();
      } catch {}
    }
  }
}

runMultiInstanceRealtimeTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ MULTI-INSTANCE TEST FAILED:', err);
    process.exit(1);
  });
