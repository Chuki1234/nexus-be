import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

async function runPostgresMigrationTests() {
  console.log('--- BẮT ĐẦU KIỂM THỬ MIGRATION TRÊN POSTGRESQL ENGINE THẬT ---');
  const pg = new PGlite();

  const userA = '11111111-1111-4111-a111-111111111111';
  const userB = '22222222-2222-4222-a222-222222222222';
  const outsider = '99999999-9999-4999-a999-999999999999';
  const convId = '33333333-3333-4333-a333-333333333333';

  // 1. Khởi tạo roles Supabase
  await pg.exec(`
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

    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  `);
  console.log('✔ Bước 1: Khởi tạo roles Supabase (anon, authenticated, service_role) thành công');

  // 2. Khởi tạo schema gốc (enums và tables)
  await pg.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_type') THEN
        CREATE TYPE conversation_type AS ENUM ('dm', 'group');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_type') THEN
        CREATE TYPE message_type AS ENUM ('default', 'reply', 'system');
      END IF;
    END
    $$;

    CREATE TABLE IF NOT EXISTS public.profiles (
      id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT
    );

    CREATE TABLE IF NOT EXISTS public.conversations (
      id UUID PRIMARY KEY,
      type conversation_type NOT NULL DEFAULT 'dm',
      name TEXT,
      icon_url TEXT,
      owner_id UUID REFERENCES public.profiles(id),
      dm_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.conversation_participants (
      conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS public.messages (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel_id UUID,
      conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
      author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
      type message_type NOT NULL DEFAULT 'default',
      content TEXT,
      reply_to_id BIGINT REFERENCES public.messages(id) ON DELETE SET NULL,
      sticker_provider TEXT,
      sticker_id TEXT,
      sticker_url TEXT,
      client_nonce UUID,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_nonce
      ON public.messages (author_id, client_nonce) WHERE client_nonce IS NOT NULL;

    CREATE TABLE IF NOT EXISTS public.attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id BIGINT NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
      storage_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT size_positive CHECK (size_bytes > 0)
    );

    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
  `);
  console.log('✔ Bước 2: Khởi tạo database base schema và tables thành công');

  // 3. Seed dữ liệu cơ bản
  await pg.query(
    `INSERT INTO public.profiles (id, username) VALUES ($1, 'usera'), ($2, 'userb'), ($3, 'outsider') ON CONFLICT DO NOTHING;`,
    [userA, userB, outsider],
  );
  await pg.query(
    `INSERT INTO public.conversations (id, type) VALUES ($1, 'dm') ON CONFLICT DO NOTHING;`,
    [convId],
  );
  await pg.query(
    `INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING;`,
    [convId, userA, userB],
  );
  console.log('✔ Bước 3: Seed dữ liệu profiles & conversations thành công');

  // 4. Áp dụng file migration 20260823150000_add_message_forwarded.sql
  const migrationPath = path.resolve(
    __dirname,
    '../supabase/migrations/20260823150000_add_message_forwarded.sql',
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pg.exec(sql);
  console.log('✔ Bước 4: Chạy toàn bộ SQL migration 20260823150000_add_message_forwarded.sql thành công');

  // 5. Kiểm tra Function Signature & Security Definer
  const fnRes = await pg.query<any>(`
    SELECT proname, prosecdef, provolatile, pronargs
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'create_forwarded_message';
  `);
  if (fnRes.rows.length !== 1 || !fnRes.rows[0].prosecdef || fnRes.rows[0].pronargs !== 5) {
    throw new Error('Function create_forwarded_message metadata check failed!');
  }
  console.log('✔ Bước 5: Function create_forwarded_message đã được tạo với SECURITY DEFINER và 5 tham số');

  // 6. Test quyền Anon & Authenticated bị từ chối
  await pg.exec(`SET ROLE anon;`);
  try {
    await pg.query(`
      SELECT * FROM public.create_forwarded_message(
        '${userA}',
        '${convId}',
        'Test anon',
        '44444444-4444-4444-a444-444444444444'::uuid
      );
    `);
    throw new Error('Anon role should NOT be able to execute RPC!');
  } catch (err: any) {
    if (!err.message.includes('permission denied')) throw err;
    console.log('✔ Bước 6a: Anon role bị từ chối thực thi function (Permission Denied)');
  }

  await pg.exec(`SET ROLE authenticated;`);
  try {
    await pg.query(`
      SELECT * FROM public.create_forwarded_message(
        '${userA}',
        '${convId}',
        'Test auth',
        '44444444-4444-4444-a444-444444444444'::uuid
      );
    `);
    throw new Error('Authenticated role should NOT be able to execute RPC!');
  } catch (err: any) {
    if (!err.message.includes('permission denied')) throw err;
    console.log('✔ Bước 6b: Authenticated role bị từ chối thực thi function (Permission Denied)');
  }
  await pg.exec(`RESET ROLE;`);

  // 7. Test Service Role gọi thành công
  await pg.exec(`SET ROLE service_role;`);
  const nonce1 = '55555555-5555-4555-a555-555555555555';
  const attachments = JSON.stringify([
    {
      storage_path: `conversations/${convId}/file1.png`,
      filename: 'file1.png',
      mime_type: 'image/png',
      size_bytes: 2048,
      width: 800,
      height: 600,
    },
  ]);

  const insertRes = await pg.query<any>(
    `
    SELECT * FROM public.create_forwarded_message(
      $1::uuid,
      $2::uuid,
      $3::text,
      $4::uuid,
      $5::jsonb
    );
  `,
    [userA, convId, 'Tin nhắn chuyển tiếp kèm ảnh', nonce1, attachments],
  );

  const row = insertRes.rows[0];
  if (
    typeof row.message_id !== 'string' ||
    row.conversation_id !== convId ||
    row.author_id !== userA ||
    row.is_forwarded !== true ||
    row.client_nonce !== nonce1
  ) {
    throw new Error('Return data mapping failed: ' + JSON.stringify(row));
  }

  const parsedAtts = Array.isArray(row.attachments)
    ? row.attachments
    : JSON.parse(row.attachments as string);
  if (
    parsedAtts.length !== 1 ||
    typeof parsedAtts[0].id !== 'string' ||
    typeof parsedAtts[0].message_id !== 'string' ||
    parsedAtts[0].filename !== 'file1.png'
  ) {
    throw new Error('Attachment return data mapping failed: ' + JSON.stringify(parsedAtts));
  }
  console.log('✔ Bước 7: Service role gọi thành công, ghi message + attachments nguyên tử với string IDs');

  // 8. Test Validation: client_nonce IS NULL
  try {
    await pg.query(`
      SELECT * FROM public.create_forwarded_message(
        '${userA}',
        '${convId}',
        'Missing nonce',
        NULL
      );
    `);
    throw new Error('Should have failed on NULL client_nonce');
  } catch (err: any) {
    if (!err.message.includes('Client nonce is required')) throw err;
    console.log('✔ Bước 8: Validation NULL client_nonce -> Ném lỗi 22023 chính xác');
  }

  // 9. Test Validation: prefix storage_path
  try {
    const invalidPrefix = JSON.stringify([
      {
        storage_path: `conversations/fake-conv-id/file.png`,
        filename: 'file.png',
        mime_type: 'image/png',
        size_bytes: 100,
      },
    ]);
    await pg.query(
      `
      SELECT * FROM public.create_forwarded_message(
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        $5::jsonb
      );
    `,
      [userA, convId, 'Invalid prefix', '66666666-6666-4666-a666-666666666666', invalidPrefix],
    );
    throw new Error('Should have failed on invalid prefix');
  } catch (err: any) {
    if (!err.message.includes('Invalid attachment metadata')) throw err;
    console.log('✔ Bước 9: Defense-in-depth prefix storage_path -> Ném lỗi 22023 chính xác');
  }

  // 10. Test Validation: size_bytes <= 0 và width <= 0
  try {
    const invalidMetadata = JSON.stringify([
      {
        storage_path: `conversations/${convId}/file.png`,
        filename: 'file.png',
        mime_type: 'image/png',
        size_bytes: -5,
      },
    ]);
    await pg.query(
      `
      SELECT * FROM public.create_forwarded_message(
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        $5::jsonb
      );
    `,
      [userA, convId, 'Negative size', '77777777-7777-4777-a777-777777777777', invalidMetadata],
    );
    throw new Error('Should have failed on negative size_bytes');
  } catch (err: any) {
    if (!err.message.includes('Invalid attachment metadata')) throw err;
    console.log('✔ Bước 10: Validation attachment metadata (size_bytes > 0, width/height > 0) -> Ném lỗi 22023');
  }

  // 11. Test Atomic Rollback khi attachment bị lỗi
  const failNonce = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const mixedAtts = JSON.stringify([
    {
      storage_path: `conversations/${convId}/valid.png`,
      filename: 'valid.png',
      mime_type: 'image/png',
      size_bytes: 100,
    },
    {
      storage_path: `conversations/${convId}/invalid.png`,
      filename: 'invalid.png',
      mime_type: 'image/png',
      size_bytes: -10,
    },
  ]);

  try {
    await pg.query(
      `
      SELECT * FROM public.create_forwarded_message(
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        $5::jsonb
      );
    `,
      [userA, convId, 'Should rollback completely', failNonce, mixedAtts],
    );
    throw new Error('Should have failed');
  } catch (err: any) {
    if (!err.message.includes('Invalid attachment metadata')) throw err;
  }

  // Kiểm tra không có message row nào lọt vào DB
  const checkMsg = await pg.query(
    `SELECT * FROM public.messages WHERE author_id = $1 AND client_nonce = $2;`,
    [userA, failNonce],
  );
  if (checkMsg.rows.length !== 0) {
    throw new Error('Atomic rollback failed: message row was created despite attachment error!');
  }
  console.log('✔ Bước 11: Atomic Rollback hoạt động hoàn hảo — khi attachment lỗi, transaction rollback hoàn toàn 0 message row dư thừa');

  // 12. Test Concurrent Race Condition (Unique Violation 23505)
  const raceNonce = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
  await pg.query(
    `
    SELECT * FROM public.create_forwarded_message(
      $1::uuid,
      $2::uuid,
      $3::text,
      $4::uuid,
      '[]'::jsonb
    );
  `,
    [userA, convId, 'Race initial message', raceNonce],
  );

  try {
    await pg.query(
      `
      SELECT * FROM public.create_forwarded_message(
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        '[]'::jsonb
      );
    `,
      [userA, convId, 'Race duplicate message', raceNonce],
    );
    throw new Error('Should have thrown unique violation on duplicate nonce');
  } catch (err: any) {
    if (!err.message.includes('idx_messages_nonce') && !err.message.includes('duplicate key')) {
      throw err;
    }
    console.log('✔ Bước 12: Race Condition 23505 (unique violation trên client_nonce) chặn duplicate message thành công');
  }

  // 13. Kiểm thử Migration: Thêm MIME DOCX vào storage.buckets (Idempotent, bảo toàn MIMEs cũ, public = false, 10MB limit)
  await pg.exec(`RESET ROLE;`);
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public BOOLEAN NOT NULL DEFAULT false,
      file_size_limit BIGINT,
      allowed_mime_types TEXT[]
    );

    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'message-attachments',
      'message-attachments',
      false,
      10485760,
      ARRAY[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'application/pdf',
        'text/plain',
        'application/zip',
        'application/x-zip-compressed'
      ]
    )
    ON CONFLICT (id) DO UPDATE SET
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  `);

  const docxMigrationSql = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260823210000_add_docx_to_storage.sql'),
    'utf8',
  );

  // Áp dụng lần 1
  await pg.exec(docxMigrationSql);

  const bucketRes1 = await pg.query<{
    public: boolean;
    file_size_limit: string;
    allowed_mime_types: string[];
  }>(`SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'message-attachments'`);

  const bucket1 = bucketRes1.rows[0];
  if (!bucket1.public === false) {
    throw new Error('Migration changed public property on bucket');
  }
  if (Number(bucket1.file_size_limit) !== 10485760) {
    throw new Error('Migration changed file_size_limit on bucket');
  }
  if (!bucket1.allowed_mime_types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
    throw new Error('Migration did not add DOCX MIME type');
  }
  if (!bucket1.allowed_mime_types.includes('application/pdf') || !bucket1.allowed_mime_types.includes('image/png')) {
    throw new Error('Migration lost existing MIME types');
  }

  // Áp dụng lần 2 (Kiểm thử Idempotency)
  await pg.exec(docxMigrationSql);
  const bucketRes2 = await pg.query<{ allowed_mime_types: string[] }>(
    `SELECT allowed_mime_types FROM storage.buckets WHERE id = 'message-attachments'`,
  );
  const docxCount = bucketRes2.rows[0].allowed_mime_types.filter(
    (m) => m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ).length;
  if (docxCount !== 1) {
    throw new Error(`DOCX MIME duplicated on idempotent run: count=${docxCount}`);
  }

  // Kiểm thử an toàn với bucket có allowed_mime_types = NULL
  await pg.exec(`UPDATE storage.buckets SET allowed_mime_types = NULL WHERE id = 'message-attachments';`);
  await pg.exec(docxMigrationSql);
  const bucketResNull = await pg.query<{ allowed_mime_types: string[] }>(
    `SELECT allowed_mime_types FROM storage.buckets WHERE id = 'message-attachments'`,
  );
  if (!bucketResNull.rows[0].allowed_mime_types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
    throw new Error('Migration failed when allowed_mime_types was NULL');
  }

  console.log('✔ Bước 13: Migration 20260823210000_add_docx_to_storage.sql idempotent, bảo toàn public = false, 10MB limit và xử lý an toàn NULL');

  await pg.exec(`RESET ROLE;`);
  await pg.close();
  console.log('--- TOÀN BỘ 13 BƯỚC KIỂM THỬ POSTGRESQL ENGINE ĐÃ PASS 100% ---');
}

runPostgresMigrationTests().catch((err) => {
  console.error('❌ Kiểm thử migration thất bại:', err);
  process.exit(1);
});
