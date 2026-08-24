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
 * Native PostgreSQL Multi-Session Concurrency Test Suite
 *
 * Kiểm thử tính đúng đắn trên PostgreSQL native qua 2 connection độc lập:
 * 1. Backend PIDs khác nhau (SELECT pg_backend_pid()).
 * 2. Duplicate nonce concurrency overlap (1 success, 1 23505, đúng 1 canonical row).
 * 3. Transaction A giữ advisory lock (pg_locks).
 * 4. Session B bị pending/blocked trước khi Session A COMMIT.
 * 5. Sau khi Session A COMMIT, Session B hoàn tất thành công.
 * 6. Final channel state trong public.channels hợp lệ.
 * 7. Cleanup toàn bộ test resources sạch sẽ.
 */
async function runChannelConcurrencyPostgresTest() {
  console.log('======================================================================');
  console.log('  NATIVE POSTGRESQL MULTI-SESSION CONCURRENCY TEST SUITE');
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
    // SEED DYNAMIC TEST DATA (Không dùng ID tĩnh cố định)
    // -------------------------------------------------------------------------
    const ownerId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    await clientA.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'native_owner@nexus.gg') ON CONFLICT (id) DO NOTHING;`, [ownerId]);
    await clientA.query(`INSERT INTO public.profiles (id, username, display_name, birthdate) VALUES ($1, 'native_owner', 'Native Owner', '2000-01-01') ON CONFLICT (id) DO NOTHING;`, [ownerId]);
    await clientA.query(`INSERT INTO public.servers (id, name, owner_id) VALUES ($1, 'Concurrency Native Server', $2);`, [serverId, ownerId]);
    await clientA.query(`SELECT public.create_default_role($1);`, [serverId]);
    await clientA.query(`INSERT INTO public.server_members (server_id, user_id) VALUES ($1, $2);`, [serverId, ownerId]);
    await clientA.query(`INSERT INTO public.channels (id, server_id, name, type, position) VALUES ($1, $2, 'general-chat', 'text', 0);`, [channelId, serverId]);

    console.log('✔ Seed dữ liệu dynamic test server, channel và permissions thành công');

    // -------------------------------------------------------------------------
    // ASSERTION 2: Duplicate client_nonce overlap (1 success, 1 23505, 1 canonical row)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 1: Multi-Session Concurrent create_channel_message Overlap ---');
    const testNonce = crypto.randomUUID();

    const pA = clientA.query(
      'SELECT public.create_channel_message($1, $2, $3, $4::uuid)',
      [channelId, ownerId, 'Message from Session A', testNonce],
    );

    const pB = clientB.query(
      'SELECT public.create_channel_message($1, $2, $3, $4::uuid)',
      [channelId, ownerId, 'Message from Session B', testNonce],
    );

    const [resA, resB] = await Promise.allSettled([pA, pB]);
    const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
    const failures = [resA, resB].filter((r) => r.status === 'rejected');

    if (successes.length !== 1 || failures.length !== 1) {
      throw new Error(`Kỳ vọng 1 session thành công và 1 session thất bại (23505), nhưng nhận được: ${successes.length} success, ${failures.length} fail`);
    }

    const failedReason = (failures[0] as PromiseRejectedResult).reason;
    const errorCode = failedReason.code || '';
    const errorMsg = failedReason.message || '';

    if (errorCode !== '23505' && !errorMsg.includes('23505') && !errorMsg.includes('duplicate key')) {
      throw new Error(`Session thua cuộc phải nhận mã lỗi 23505 (unique_violation), nhưng nhận: code=${errorCode}, msg=${errorMsg}`);
    }

    const rowCountRes = await clientA.query(
      'SELECT count(*)::text as count FROM public.messages WHERE author_id = $1 AND client_nonce = $2::uuid',
      [ownerId, testNonce],
    );
    if (rowCountRes.rows[0].count !== '1') {
      throw new Error(`Kỳ vọng đúng 1 canonical row trong database, nhận được: ${rowCountRes.rows[0].count}`);
    }
    console.log(`✔ [Assertion 2] 2 Session gửi đồng thời cùng client_nonce: 1 session thành công, 1 session nhận 23505 (${errorCode}), DB có đúng 1 canonical row.`);

    // -------------------------------------------------------------------------
    // ASSERTION 3, 4, 5, 6: Advisory Lock Serialization & Final Channel State
    // -------------------------------------------------------------------------
    console.log('\n--- TEST 2: Multi-Session Advisory Lock Serialization ---');

    // Bước 3.1: Session A mở transaction và gọi update_server_channel (lấy pg_advisory_xact_lock)
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
    console.log(`✔ [Assertion 3] Transaction A (PID: ${pidA}) đang giữ advisory lock trong transaction mở.`);

    // Bước 3.2: Session B cố gắng update cùng server/channel trong lúc Session A chưa COMMIT
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
    console.log('✔ [Assertion 4] Session B (PID: ' + pidB + ') đang pending bị block chờ Session A giải phóng lock.');

    // Bước 3.3: Session A COMMIT -> Session B được unblock và hoàn thành
    await clientA.query('COMMIT');
    await sessionBPromise;

    if (sessionBError) {
      throw new Error(`Session B thất bại sau khi A commit: ${sessionBError.message}`);
    }
    console.log('✔ [Assertion 5] Session A COMMIT -> Session B được unblock và hoàn tất tuần tự thành công.');

    // Bước 3.4: Kiểm tra trạng thái cuối cùng của channel trong public.channels
    const finalChanRes = await clientA.query(
      'SELECT name, topic FROM public.channels WHERE id = $1',
      [channelId],
    );
    const finalChan = finalChanRes.rows[0];
    if (finalChan.name !== 'updated-by-session-b' || finalChan.topic !== 'Topic B') {
      throw new Error(`Trạng thái cuối cùng của channel không hợp lệ: ${JSON.stringify(finalChan)}`);
    }
    console.log(`✔ [Assertion 6] Final channel state hợp lệ trong public.channels: name="${finalChan.name}", topic="${finalChan.topic}".`);

    console.log('\n======================================================================');
    console.log('🎉 TOÀN BỘ 7 ASSERTIONS NATIVE POSTGRESQL CONCURRENCY ĐÃ PASS 100%');
    console.log('======================================================================');
  } finally {
    // -------------------------------------------------------------------------
    // ASSERTION 7: Cleanup test resources thành công
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
        console.log(`✔ [Assertion 7] Đã xóa test database tạm thời "${dedicatedTestDbName}"`);
      } catch (e: any) {
        console.warn('Lưu ý khi dọn dẹp test database:', e.message);
      }
    }

    if (ephemeralPg) {
      try {
        await ephemeralPg.stop();
        console.log('✔ [Assertion 7] Đã tắt Ephemeral Native PostgreSQL server');
      } catch (e: any) {
        console.warn('Lưu ý khi tắt ephemeral pg:', e.message);
      }
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('✔ [Assertion 7] Đã dọn dẹp thư mục dữ liệu tạm thời');
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
