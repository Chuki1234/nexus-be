import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as net from 'net';

/**
 * Tìm cổng khả dụng ngẫu nhiên trên localhost
 */
function getAvailablePort(preferredPort = 54332): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      // Nếu preferredPort bận, lấy cổng ngẫu nhiên 0
      const altServer = net.createServer();
      altServer.unref();
      altServer.on('error', reject);
      altServer.listen(0, '127.0.0.1', () => {
        const port = (altServer.address() as net.AddressInfo).port;
        altServer.close(() => resolve(port));
      });
    });
    server.listen(preferredPort, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Native PostgreSQL Multi-Session Concurrency & Transaction Integrity Test Suite
 *
 * Kiểm thử tính đúng đắn trên PostgreSQL native qua 2 connection độc lập:
 * 1. Backend PIDs khác nhau (SELECT pg_backend_pid()).
 * 2. Channel message duplicate client_nonce concurrency with external media (1 success, 1 23505, đúng 1 canonical message + 1 external_media row, cả 2 session nhận cùng canonical ID).
 * 3. DM conversation message duplicate client_nonce concurrency with external media (1 success, 1 23505, đúng 1 canonical message + 1 external_media row, cả 2 session nhận cùng canonical ID).
 * 4. Channel RPC Real Late-Failure Rollback (Message INSERT thành công -> Media INSERT vi phạm table CHECK constraint -> Toàn bộ RPC rollback, 0 orphan message/media/attachment).
 * 5. DM RPC Real Late-Failure Rollback (Message INSERT thành công -> Media INSERT vi phạm table CHECK constraint -> Toàn bộ RPC rollback, 0 orphan message/media/attachment).
 * 6. Transaction A giữ advisory lock (pg_locks).
 * 7. Session B bị pending/blocked trước khi Session A COMMIT.
 * 8. Sau khi Session A COMMIT, Session B hoàn tất thành công.
 * 9. Final channel state trong public.channels hợp lệ.
 * 10. Cleanup toàn bộ test resources sạch sẽ.
 */
async function runChannelConcurrencyPostgresTest() {
  console.log('======================================================================');
  console.log('  NATIVE POSTGRESQL MULTI-SESSION CONCURRENCY & INTEGRITY TEST');
  console.log('======================================================================');

  let testDbUrl = process.env.TEST_DATABASE_URL;
  let ephemeralPg: any = null;
  let tempDir = '';
  let clientA: Client | null = null;
  let clientB: Client | null = null;
  let dedicatedTestDbName = '';

  // 1. Kiểm tra môi trường và khởi tạo database
  if (!testDbUrl) {
    if (process.env.ALLOW_SKIP_NATIVE_PG === '1') {
      console.log('ℹ [SKIP] Biến ALLOW_SKIP_NATIVE_PG=1 được bật. Bỏ qua native PostgreSQL test theo yêu cầu.');
      process.exit(0);
    }

    console.log('📦 Không tìm thấy TEST_DATABASE_URL. Đang khởi tạo Ephemeral Native PostgreSQL cluster cục bộ...');
    try {
      tempDir = path.join(os.tmpdir(), `nexus-ephemeral-pg-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const EmbeddedPostgres = require('embedded-postgres').default || require('embedded-postgres');
      const port = await getAvailablePort(54332);

      ephemeralPg = new EmbeddedPostgres({
        port,
        user: 'postgres',
        password: 'postgrespassword',
        databaseDir: path.join(tempDir, 'data'),
      });

      await ephemeralPg.initialise();
      await ephemeralPg.start();

      testDbUrl = `postgresql://postgres:postgrespassword@127.0.0.1:${port}/postgres`;
      console.log(`✔ Ephemeral Native PostgreSQL đã khởi động thành công trên cổng ${port}`);
    } catch (err: any) {
      console.error('❌ Không thể khởi động Ephemeral Native PostgreSQL:', err.message || err);
      console.error('ℹ Vui lòng khởi động PostgreSQL hoặc cung cấp TEST_DATABASE_URL hợp lệ.');
      process.exit(1);
    }
  }

  // 2. Safety Guards: Kiểm tra URL an toàn, tuyệt đối không trỏ tới Supabase production
  try {
    const parsedUrl = new URL(testDbUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    const dbName = parsedUrl.pathname.replace(/^\//, '').toLowerCase();

    if (
      hostname.includes('supabase.co') ||
      hostname.includes('supabase.in') ||
      hostname.includes('pooler.supabase.com') ||
      hostname.includes('aws') ||
      hostname.includes('prod')
    ) {
      console.error('⛔ AN TOÀN VI PHẠM: TEST_DATABASE_URL không được phép trỏ tới môi trường remote/production!');
      process.exit(1);
    }

    if (
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      hostname !== '::1' &&
      !dbName.includes('test')
    ) {
      console.error('⛔ AN TOÀN VI PHẠM: TEST_DATABASE_URL phải trỏ tới localhost/127.0.0.1 hoặc database có tên chứa "test"!');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('⛔ URL database không hợp lệ:', err.message);
    process.exit(1);
  }

  // Tạo database riêng với mã hóa UTF-8 để hỗ trợ đầy đủ tiếng Việt và ký tự quốc tế
  dedicatedTestDbName = `nexus_concurrency_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const rootClient = new Client({ connectionString: testDbUrl });
  await rootClient.connect();
  try {
    try {
      await rootClient.query(`CREATE DATABASE "${dedicatedTestDbName}" WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`);
    } catch {
      await rootClient.query(`CREATE DATABASE "${dedicatedTestDbName}" WITH ENCODING 'UTF8';`);
    }
    console.log(`✔ Đã tạo test database UTF-8 riêng biệt: "${dedicatedTestDbName}"`);
  } finally {
    await rootClient.end();
  }

  const testDbUrlWithDb = new URL(testDbUrl);
  testDbUrlWithDb.pathname = `/${dedicatedTestDbName}`;
  const dedicatedConnString = testDbUrlWithDb.toString();

  console.log(`📡 Đang thiết lập 2 kết nối độc lập tới Native PostgreSQL ("${dedicatedTestDbName}")...`);
  clientA = new Client({ connectionString: dedicatedConnString });
  clientB = new Client({ connectionString: dedicatedConnString });

  await clientA.connect();
  await clientB.connect();

  try {
    // -------------------------------------------------------------------------
    // ASSERTION 1: Hai connection có backend PID khác nhau (SELECT pg_backend_pid())
    // -------------------------------------------------------------------------
    const pidARes = await clientA.query('SELECT pg_backend_pid() AS pid');
    const pidBRes = await clientB.query('SELECT pg_backend_pid() AS pid');
    const pidA = pidARes.rows[0].pid;
    const pidB = pidBRes.rows[0].pid;

    console.log(`✔ [Assertion 1] Session A (PID: ${pidA}) và Session B (PID: ${pidB}) là 2 backend processes độc lập.`);
    if (pidA === pidB) {
      throw new Error(`Lỗi: Hai sessions dùng chung PID ${pidA}! Đây không phải 2 kết nối độc lập.`);
    }

    // -------------------------------------------------------------------------
    // BOOTSTRAP CANONICAL SCHEMA & MIGRATIONS
    // -------------------------------------------------------------------------
    console.log('\n--- Nạp Canonical Database Base Schema & Prerequisite Migrations ---');

    await clientA.query(`
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
        email TEXT
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
        name TEXT NOT NULL,
        owner UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        public BOOLEAN DEFAULT FALSE,
        avif_autodetection BOOLEAN DEFAULT FALSE,
        file_size_limit BIGINT,
        allowed_mime_types TEXT[],
        owner_id TEXT
      );

      CREATE TABLE IF NOT EXISTS storage.objects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id TEXT REFERENCES storage.buckets(id),
        name TEXT,
        owner UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB,
        path_tokens TEXT[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED
      );

      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'message-attachments',
        'message-attachments',
        false,
        10485760,
        ARRAY[
          'image/jpeg', 'image/png', 'image/webp', 'image/gif',
          'application/pdf', 'text/plain', 'application/zip',
          'application/x-zip-compressed'
        ]
      )
      ON CONFLICT (id) DO UPDATE SET
        public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);

    // Danh sách toàn bộ canonical migrations trong repo theo thứ tự thời gian chuẩn
    const migrationsDir = path.join(__dirname, '../supabase/migrations');
    const canonicalMigrations = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const migName of canonicalMigrations) {
      const migPath = path.join(migrationsDir, migName);
      const migSql = fs.readFileSync(migPath, 'utf8');
      await clientA.query(migSql);
      // Đảm bảo các function helper kế thừa luôn khả dụng cho các migration tiếp theo
      await clientA.query(`
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
    console.log(`✔ Đã áp dụng toàn bộ ${canonicalMigrations.length} canonical migrations của repo theo đúng thứ tự`);

    // -------------------------------------------------------------------------
    // SEED DYNAMIC TEST DATA
    // -------------------------------------------------------------------------
    const ownerId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    await clientA.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'native_owner@nexus.gg') ON CONFLICT (id) DO NOTHING;`, [ownerId]);
    await clientA.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'native_member@nexus.gg') ON CONFLICT (id) DO NOTHING;`, [memberId]);

    await clientA.query(`INSERT INTO public.profiles (id, username, display_name, birthdate) VALUES ($1, 'native_owner', 'Native Owner', '2000-01-01') ON CONFLICT (id) DO NOTHING;`, [ownerId]);
    await clientA.query(`INSERT INTO public.profiles (id, username, display_name, birthdate) VALUES ($1, 'native_member', 'Native Member', '2000-01-01') ON CONFLICT (id) DO NOTHING;`, [memberId]);

    await clientA.query(`INSERT INTO public.servers (id, name, owner_id) VALUES ($1, 'Concurrency Native Server', $2);`, [serverId, ownerId]);
    await clientA.query(`SELECT public.create_default_role($1);`, [serverId]);
    await clientA.query(`INSERT INTO public.server_members (server_id, user_id) VALUES ($1, $2);`, [serverId, ownerId]);
    await clientA.query(`INSERT INTO public.server_members (server_id, user_id) VALUES ($1, $2);`, [serverId, memberId]);
    await clientA.query(`INSERT INTO public.channels (id, server_id, name, type, position) VALUES ($1, $2, 'general-chat', 'text', 0);`, [channelId, serverId]);

    // Seed direct message conversation
    await clientA.query(`INSERT INTO public.conversations (id, type) VALUES ($1, 'dm');`, [conversationId]);
    await clientA.query(`INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3);`, [conversationId, ownerId, memberId]);

    console.log('✔ Seed dữ liệu dynamic test server, channel, DM conversation và permissions thành công');

    const validGifMedia = {
      provider: 'giphy',
      externalId: 'YQitOmg976101WnSYP',
      mediaType: 'gif',
      title: 'Excited Celebration GIF',
      creatorUsername: 'giphy_artist',
      pageUrl: 'https://giphy.com/gifs/YQitOmg976101WnSYP',
      previewUrl: 'https://media.giphy.com/media/YQitOmg976101WnSYP/giphy-preview.gif',
      displayUrl: 'https://media.giphy.com/media/YQitOmg976101WnSYP/giphy.gif',
      mp4Url: 'https://media.giphy.com/media/YQitOmg976101WnSYP/giphy.mp4',
      width: 480,
      height: 270,
    };

    // -------------------------------------------------------------------------
    // ASSERTION 2A: Multi-Session Concurrent create_channel_message Overlap với External Media
    // (True Idempotent RPC Semantics: Cả winner và loser đều nhận cùng canonical ID, không ném exception)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 1: Multi-Session Concurrent create_channel_message Overlap (Channel + GIPHY) ---');
    const chanTestNonce = crypto.randomUUID();

    // Session A mở transaction và gọi RPC
    await clientA.query('BEGIN');
    const chanResAPromise = clientA.query(
      'SELECT public.create_channel_message($1, $2, $3, $4::uuid, NULL, $5::jsonb, false, $6::jsonb)',
      [channelId, ownerId, 'Channel GIF from Session A', chanTestNonce, '[]', JSON.stringify(validGifMedia)],
    );
    const chanResA = await chanResAPromise;
    const msgFromA = chanResA.rows[0].create_channel_message;
    const canonicalChanMsgId = msgFromA.id;

    // Trong khi Session A chưa COMMIT, Session B cố gắng chèn cùng client_nonce
    const chanResBPromise = clientB.query(
      'SELECT public.create_channel_message($1, $2, $3, $4::uuid, NULL, $5::jsonb, false, $6::jsonb)',
      [channelId, ownerId, 'Channel GIF from Session B', chanTestNonce, '[]', JSON.stringify(validGifMedia)],
    );

    // Chờ 150ms đảm bảo Session B đang thực sự bị block trong PostgreSQL chờ Session A
    await new Promise((r) => setTimeout(r, 150));

    // Session A commit -> unblock Session B -> Session B tự động tra cứu và trả về canonical message (isDuplicate = true)
    await clientA.query('COMMIT');
    const chanResB = await chanResBPromise;
    const msgFromB = chanResB.rows[0].create_channel_message;

    if (!msgFromA || !msgFromB) {
      throw new Error('Cả hai session đều phải nhận được payload message hợp lệ!');
    }
    if (msgFromA.id !== msgFromB.id || msgFromA.id !== canonicalChanMsgId) {
      throw new Error(`Cả hai session phải nhận cùng canonical message ID: A=${msgFromA.id}, B=${msgFromB.id}`);
    }
    if (msgFromB.isDuplicate !== true) {
      throw new Error(`Session B phải được đánh dấu là isDuplicate = true, nhận được: ${msgFromB.isDuplicate}`);
    }
    if (!msgFromB.externalMedia || msgFromB.externalMedia.externalId !== 'YQitOmg976101WnSYP') {
      throw new Error(`Duplicate response của Session B phải chứa đầy đủ externalMedia: ${JSON.stringify(msgFromB.externalMedia)}`);
    }

    const chanCountCheck = await clientA.query(
      'SELECT count(*)::text as count FROM public.messages WHERE author_id = $1 AND client_nonce = $2::uuid',
      [ownerId, chanTestNonce],
    );
    if (chanCountCheck.rows[0].count !== '1') {
      throw new Error(`Kỳ vọng đúng 1 message row trong database, nhận được: ${chanCountCheck.rows[0].count}`);
    }

    const chanMediaCheck = await clientA.query(
      'SELECT count(*)::text as count FROM public.message_external_media WHERE message_id = $1::bigint',
      [canonicalChanMsgId],
    );
    if (chanMediaCheck.rows[0].count !== '1') {
      throw new Error(`Kỳ vọng đúng 1 message_external_media row cho message ${canonicalChanMsgId}, nhận được: ${chanMediaCheck.rows[0].count}`);
    }
    console.log(`✔ [Assertion 2A] Channel RPC concurrency: Cả Session A và Session B đều nhận canonical ID=${canonicalChanMsgId} không lỗi (B có isDuplicate=true & full media), DB có đúng 1 message + 1 external_media row.`);

    // -------------------------------------------------------------------------
    // ASSERTION 2B: Multi-Session Concurrent create_conversation_message Overlap với External Media
    // (True Idempotent RPC Semantics: Cả winner và loser đều nhận cùng canonical ID, không ném exception)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Multi-Session Concurrent create_conversation_message Overlap (DM + GIPHY) ---');
    const dmTestNonce = crypto.randomUUID();

    // Session A mở transaction và gọi RPC
    await clientA.query('BEGIN');
    const dmResA = await clientA.query(
      'SELECT public.create_conversation_message($1, $2, $3, $4::uuid, NULL, $5::jsonb, false, $6::jsonb)',
      [conversationId, ownerId, 'DM GIF from Session A', dmTestNonce, '[]', JSON.stringify(validGifMedia)],
    );
    const msgDmFromA = dmResA.rows[0].create_conversation_message;
    const canonicalDmMsgId = msgDmFromA.id;

    const dmResBPromise = clientB.query(
      'SELECT public.create_conversation_message($1, $2, $3, $4::uuid, NULL, $5::jsonb, false, $6::jsonb)',
      [conversationId, ownerId, 'DM GIF from Session B', dmTestNonce, '[]', JSON.stringify(validGifMedia)],
    );

    await new Promise((r) => setTimeout(r, 150));

    await clientA.query('COMMIT');
    const dmResB = await dmResBPromise;
    const msgDmFromB = dmResB.rows[0].create_conversation_message;

    if (!msgDmFromA || !msgDmFromB) {
      throw new Error('Cả hai session DM đều phải nhận được payload message hợp lệ!');
    }
    if (msgDmFromA.id !== msgDmFromB.id || msgDmFromA.id !== canonicalDmMsgId) {
      throw new Error(`Cả hai session DM phải nhận cùng canonical message ID: A=${msgDmFromA.id}, B=${msgDmFromB.id}`);
    }
    if (msgDmFromB.isDuplicate !== true) {
      throw new Error(`Session B DM phải được đánh dấu là isDuplicate = true, nhận được: ${msgDmFromB.isDuplicate}`);
    }
    if (!msgDmFromB.externalMedia || msgDmFromB.externalMedia.externalId !== 'YQitOmg976101WnSYP') {
      throw new Error(`Duplicate response DM của Session B phải chứa đầy đủ externalMedia: ${JSON.stringify(msgDmFromB.externalMedia)}`);
    }

    const dmCountCheck = await clientA.query(
      'SELECT count(*)::text as count FROM public.messages WHERE author_id = $1 AND client_nonce = $2::uuid',
      [ownerId, dmTestNonce],
    );
    if (dmCountCheck.rows[0].count !== '1') {
      throw new Error(`Kỳ vọng đúng 1 DM message row trong database, nhận được: ${dmCountCheck.rows[0].count}`);
    }

    const dmMediaCheck = await clientA.query(
      'SELECT count(*)::text as count FROM public.message_external_media WHERE message_id = $1::bigint',
      [canonicalDmMsgId],
    );
    if (dmMediaCheck.rows[0].count !== '1') {
      throw new Error(`Kỳ vọng đúng 1 message_external_media row cho DM message ${canonicalDmMsgId}, nhận được: ${dmMediaCheck.rows[0].count}`);
    }
    console.log(`✔ [Assertion 2B] DM RPC concurrency: Cả Session A và Session B đều nhận canonical ID=${canonicalDmMsgId} không lỗi (B có isDuplicate=true & full media), DB có đúng 1 message + 1 external_media row.`);

    // -------------------------------------------------------------------------
    // ASSERTION 3: Real Late-Failure Rollback in create_channel_message
    // (Message INSERT thành công tại bước 9 -> Media INSERT vi phạm table CHECK constraint tại bước 11 -> Rollback toàn bộ)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 3: Real Late-Failure Transaction Rollback (create_channel_message) ---');
    const lateFailChanNonce = crypto.randomUUID();
    // externalId có chứa ký tự đặc biệt '***INVALID***' -> vượt qua kiểm tra cơ bản is null trong RPC nhưng vi phạm check (external_id ~ '^[a-zA-Z0-9_-]{3,64}$') của bảng
    const lateFailMedia = {
      ...validGifMedia,
      externalId: '***INVALID_CHECK_CONSTRAINT***',
    };

    let chanLateFailCaught = false;
    let chanLateFailCode = '';
    try {
      await clientA.query(
        'SELECT public.create_channel_message($1, $2, $3, $4::uuid, NULL, $5::jsonb, false, $6::jsonb)',
        [channelId, ownerId, 'Late-failure channel message', lateFailChanNonce, '[]', JSON.stringify(lateFailMedia)],
      );
    } catch (err: any) {
      chanLateFailCaught = true;
      chanLateFailCode = err.code || '';
    }

    if (!chanLateFailCaught) {
      throw new Error('Kỳ vọng create_channel_message ném lỗi CHECK constraint khi chèn media không hợp lệ!');
    }
    if (chanLateFailCode !== '23514') {
      throw new Error(`Kỳ vọng mã lỗi 23514 (check_violation), nhưng nhận: ${chanLateFailCode}`);
    }

    // Xác nhận 0 message, 0 attachment, 0 media row rớt lại
    const chanOrphanMsg = await clientA.query(
      'SELECT count(*)::text as c FROM public.messages WHERE client_nonce = $1::uuid',
      [lateFailChanNonce],
    );
    const chanOrphanMedia = await clientA.query(
      'SELECT count(*)::text as c FROM public.message_external_media WHERE external_id = $1',
      ['***INVALID_CHECK_CONSTRAINT***'],
    );
    if (chanOrphanMsg.rows[0].c !== '0' || chanOrphanMedia.rows[0].c !== '0') {
      throw new Error(`Rollback thất bại: còn tồn tại orphan row (msg: ${chanOrphanMsg.rows[0].c}, media: ${chanOrphanMedia.rows[0].c})!`);
    }
    console.log(`✔ [Assertion 3] Channel RPC Late-Failure Rollback: Message INSERT đã chạy nhưng bước chèn media vi phạm table CHECK (23514) -> Toàn bộ transaction rollback sạch sẽ (0 orphan message, 0 orphan media).`);

    // -------------------------------------------------------------------------
    // ASSERTION 4: Real Late-Failure Rollback in create_conversation_message
    // (Message INSERT thành công tại bước 7 -> Media INSERT vi phạm table CHECK constraint tại bước 9 -> Rollback toàn bộ)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 4: Real Late-Failure Transaction Rollback (create_conversation_message) ---');
    const lateFailDmNonce = crypto.randomUUID();
    let dmLateFailCaught = false;
    let dmLateFailCode = '';
    try {
      await clientA.query(
        'SELECT public.create_conversation_message($1, $2, $3, $4::uuid, NULL, $5::jsonb, false, $6::jsonb)',
        [conversationId, ownerId, 'Late-failure DM message', lateFailDmNonce, '[]', JSON.stringify(lateFailMedia)],
      );
    } catch (err: any) {
      dmLateFailCaught = true;
      dmLateFailCode = err.code || '';
    }

    if (!dmLateFailCaught) {
      throw new Error('Kỳ vọng create_conversation_message ném lỗi CHECK constraint khi chèn media không hợp lệ!');
    }
    if (dmLateFailCode !== '23514') {
      throw new Error(`Kỳ vọng mã lỗi 23514 (check_violation), nhưng nhận: ${dmLateFailCode}`);
    }

    const dmOrphanMsg = await clientA.query(
      'SELECT count(*)::text as c FROM public.messages WHERE client_nonce = $1::uuid',
      [lateFailDmNonce],
    );
    const dmOrphanMedia = await clientA.query(
      'SELECT count(*)::text as c FROM public.message_external_media WHERE external_id = $1',
      ['***INVALID_CHECK_CONSTRAINT***'],
    );
    if (dmOrphanMsg.rows[0].c !== '0' || dmOrphanMedia.rows[0].c !== '0') {
      throw new Error(`Rollback thất bại: còn tồn tại orphan DM row (msg: ${dmOrphanMsg.rows[0].c}, media: ${dmOrphanMedia.rows[0].c})!`);
    }
    console.log(`✔ [Assertion 4] DM RPC Late-Failure Rollback: Message INSERT đã chạy nhưng bước chèn media vi phạm table CHECK (23514) -> Toàn bộ transaction rollback sạch sẽ (0 orphan message, 0 orphan media).`);

    // -------------------------------------------------------------------------
    // ASSERTION 5, 6, 7, 8: Advisory Lock Serialization & Final Channel State
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 5: Multi-Session Advisory Lock Serialization ---');

    // Bước 5.1: Session A mở transaction và gọi update_server_channel (lấy pg_advisory_xact_lock)
    await clientA.query('BEGIN');
    await clientA.query(
      'SELECT public.update_server_channel($1, $2, $3, $4, $5)',
      [serverId, channelId, ownerId, 'locked-by-session-a', 'Topic A'],
    );

    // Kiểm tra Session A đang giữ advisory lock trong pg_locks
    const lockQuery = await clientA.query(
      "SELECT count(*)::text as c FROM pg_locks WHERE locktype = 'advisory' AND pid = $1",
      [pidA],
    );
    if (Number(lockQuery.rows[0].c) < 1) {
      throw new Error('Transaction A không giữ advisory lock trong pg_locks!');
    }
    console.log(`✔ [Assertion 5] Transaction A (PID: ${pidA}) đang giữ advisory lock trong transaction mở.`);

    // Bước 5.2: Session B cố gắng update cùng server/channel trong lúc Session A chưa COMMIT
    let sessionBCompletedBeforeCommit = false;
    let sessionBError: any = null;

    const sessionBPromise = (async () => {
      try {
        await clientB.query(
          'SELECT public.update_server_channel($1, $2, $3, $4, $5)',
          [serverId, channelId, ownerId, 'updated-by-session-b', 'Topic B'],
        );
      } catch (err) {
        sessionBError = err;
      } finally {
        sessionBCompletedBeforeCommit = true;
      }
    })();

    // Chờ 250ms để kiểm tra xem Session B có bị block chờ Session A không
    await new Promise((r) => setTimeout(r, 250));

    if (sessionBCompletedBeforeCommit) {
      throw new Error('Lỗi: Session B đã hoàn thành trước khi Session A COMMIT! Advisory lock không serialize được.');
    }
    console.log('✔ [Assertion 6] Session B (PID: ' + pidB + ') đang pending bị block chờ Session A giải phóng lock.');

    // Bước 5.3: Session A COMMIT -> Session B được unblock và hoàn thành
    await clientA.query('COMMIT');
    await sessionBPromise;

    if (sessionBError) {
      throw new Error(`Session B thất bại sau khi A commit: ${sessionBError.message}`);
    }
    console.log('✔ [Assertion 7] Session A COMMIT -> Session B được unblock và hoàn tất tuần tự thành công.');

    // Bước 5.4: Kiểm tra trạng thái cuối cùng của channel trong public.channels
    const finalChanRes = await clientA.query(
      'SELECT name, topic FROM public.channels WHERE id = $1',
      [channelId],
    );
    const finalChan = finalChanRes.rows[0];
    if (finalChan.name !== 'updated-by-session-b' || finalChan.topic !== 'Topic B') {
      throw new Error(`Trạng thái cuối cùng của channel không hợp lệ: ${JSON.stringify(finalChan)}`);
    }
    console.log(`✔ [Assertion 8] Final channel state hợp lệ trong public.channels: name="${finalChan.name}", topic="${finalChan.topic}".`);

    console.log('\n======================================================================');
    console.log('🎉 TOÀN BỘ 8 ASSERTIONS NATIVE POSTGRESQL CONCURRENCY & ROLLBACK ĐÃ PASS 100%');
    console.log('======================================================================');
  } finally {
    // -------------------------------------------------------------------------
    // ASSERTION 9: Cleanup test resources thành công
    // -------------------------------------------------------------------------
    if (clientA) {
      try { await clientA.end(); } catch {}
    }
    if (clientB) {
      try { await clientB.end(); } catch {}
    }

    if (dedicatedTestDbName && testDbUrl) {
      try {
        const cleanupClient = new Client({ connectionString: testDbUrl });
        await cleanupClient.connect();
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${dedicatedTestDbName}" WITH (FORCE);`);
        await cleanupClient.end();
        console.log(`✔ [Assertion 9] Đã xóa test database tạm thời "${dedicatedTestDbName}"`);
      } catch (e: any) {
        console.warn('Lưu ý khi dọn dẹp test database:', e.message);
      }
    }

    if (ephemeralPg) {
      try {
        await ephemeralPg.stop();
        console.log('✔ [Assertion 9] Đã tắt Ephemeral Native PostgreSQL server');
      } catch (e: any) {
        console.warn('Lưu ý khi tắt ephemeral pg:', e.message);
      }
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('✔ [Assertion 9] Đã dọn dẹp thư mục dữ liệu tạm thời');
      } catch (e: any) {
        console.warn('Lưu ý khi xóa tempDir:', e.message);
      }
    }
  }
}

runChannelConcurrencyPostgresTest().catch((err) => {
  console.error('❌ Native PostgreSQL Concurrency Test thất bại:', err);
  process.exit(1);
});
