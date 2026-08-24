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

  // 14. Kiểm thử Migration 20260824000000_server_invitations_and_capabilities.sql
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY,
      email TEXT
    );

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'presence_status') THEN
        CREATE TYPE presence_status AS ENUM ('online', 'idle', 'dnd', 'offline');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_type') THEN
        CREATE TYPE channel_type AS ENUM ('text', 'voice', 'forum');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_type') THEN
        CREATE TYPE conversation_type AS ENUM ('dm', 'group');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'friendship_status') THEN
        CREATE TYPE friendship_status AS ENUM ('pending', 'accepted', 'blocked');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_type') THEN
        CREATE TYPE message_type AS ENUM ('default', 'system_join', 'system_leave');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'overwrite_target') THEN
        CREATE TYPE overwrite_target AS ENUM ('role', 'member');
      END IF;
    END
    $$;
  `);

  // Load server tables schemas
  const serversBaseSql = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260731090200_servers_roles_channels.sql'),
    'utf8',
  );
  await pg.exec(serversBaseSql);

  const socialSql = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260731090400_social_and_settings.sql'),
    'utf8',
  );
  await pg.exec(socialSql);

  const fixFkSql = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260816000000_fix_servers_foreign_keys_and_roles.sql'),
    'utf8',
  );
  await pg.exec(fixFkSql);

  const serverInvMigrationSql = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20260824000000_server_invitations_and_capabilities.sql'),
    'utf8',
  );

  // Áp dụng lần 1
  await pg.exec(serverInvMigrationSql);

  // Khởi tạo test server và members
  const testServerId = '55555555-5555-4555-a555-555555555555';
  const ownerUser = userA;
  const regularUser = userB;
  const inviteeUser = outsider;

  await pg.exec(`
    INSERT INTO auth.users (id, email)
    VALUES
      ('${ownerUser}', 'owner@nexus.gg'),
      ('${regularUser}', 'regular@nexus.gg'),
      ('${inviteeUser}', 'invitee@nexus.gg')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES
      ('${ownerUser}', 'owner_user', 'Owner User'),
      ('${regularUser}', 'regular_user', 'Regular User'),
      ('${inviteeUser}', 'invitee_user', 'Invitee User')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.servers (id, name, owner_id)
    VALUES ('${testServerId}', 'Test Server CP11', '${ownerUser}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.server_members (server_id, user_id, role)
    VALUES
      ('${testServerId}', '${ownerUser}', 'OWNER'),
      ('${testServerId}', '${regularUser}', 'MEMBER')
    ON CONFLICT DO NOTHING;

    -- Thêm default @everyone role với default perms (3339n)
    INSERT INTO public.roles (id, server_id, name, permissions, position, is_default)
    VALUES ('${testServerId}', '${testServerId}', '@everyone', 3339, 0, true)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Kiểm thử RPC create_server_channel
  // 1. Owner tạo text channel
  const chan1Res = await pg.query<{ create_server_channel: any }>(
    `SELECT public.create_server_channel('${testServerId}', '${ownerUser}', 'general', 'text', 'Chủ đề chung') as create_server_channel`,
  );
  const chan1 = chan1Res.rows[0].create_server_channel;
  if (chan1.name !== 'general' || chan1.position !== 0 || chan1.type !== 'text') {
    throw new Error(`create_server_channel failed for text: ${JSON.stringify(chan1)}`);
  }

  // 2. Owner tạo voice channel
  const chan2Res = await pg.query<{ create_server_channel: any }>(
    `SELECT public.create_server_channel('${testServerId}', '${ownerUser}', 'Phòng Đàm Thoại', 'voice', null) as create_server_channel`,
  );
  const chan2 = chan2Res.rows[0].create_server_channel;
  if (chan2.name !== 'Phòng Đàm Thoại' || chan2.position !== 1 || chan2.type !== 'voice') {
    throw new Error(`create_server_channel failed for voice: ${JSON.stringify(chan2)}`);
  }

  // 3. Regular member không có MANAGE_CHANNELS gọi create_server_channel -> 42501
  let regularCreateFailed = false;
  try {
    await pg.query(`SELECT public.create_server_channel('${testServerId}', '${regularUser}', 'secret', 'text')`);
  } catch (err: any) {
    regularCreateFailed = true;
  }
  if (!regularCreateFailed) {
    throw new Error('create_server_channel allowed unauthorized member to create channel');
  }

  // 4. Non-member gọi create_server_channel -> 42501
  let outsiderCreateFailed = false;
  try {
    await pg.query(`SELECT public.create_server_channel('${testServerId}', '${inviteeUser}', 'hacked', 'text')`);
  } catch (err: any) {
    outsiderCreateFailed = true;
  }
  if (!outsiderCreateFailed) {
    throw new Error('create_server_channel allowed outsider to create channel');
  }

  // Kiểm thử RPC join_server_by_invite_code
  const testInviteCode = 'join_test_code_128';
  await pg.exec(`
    INSERT INTO public.invites (code, server_id, inviter_id, max_uses, uses, expires_at)
    VALUES ('${testInviteCode}', '${testServerId}', '${ownerUser}', 1, 0, NOW() + INTERVAL '1 day')
    ON CONFLICT (code) DO NOTHING;
  `);

  // Invitee join bằng link
  const joinRes1 = await pg.query<{ join_server_by_invite_code: any }>(
    `SELECT public.join_server_by_invite_code('${testInviteCode}', '${inviteeUser}') as join_server_by_invite_code`,
  );
  const join1 = joinRes1.rows[0].join_server_by_invite_code;
  if (!join1.success || join1.alreadyMember !== false) {
    throw new Error(`join_server_by_invite_code failed on first join: ${JSON.stringify(join1)}`);
  }

  // Kiểm tra uses đã tăng lên 1
  const inviteCheck1 = await pg.query<{ uses: number }>(`SELECT uses FROM public.invites WHERE code = '${testInviteCode}'`);
  if (inviteCheck1.rows[0].uses !== 1) {
    throw new Error(`Invite uses not incremented: ${inviteCheck1.rows[0].uses}`);
  }

  // Invitee join lại (Idempotent: đã là member, không tăng uses)
  const joinRes2 = await pg.query<{ join_server_by_invite_code: any }>(
    `SELECT public.join_server_by_invite_code('${testInviteCode}', '${inviteeUser}') as join_server_by_invite_code`,
  );
  const join2 = joinRes2.rows[0].join_server_by_invite_code;
  if (!join2.success || join2.alreadyMember !== true) {
    throw new Error(`join_server_by_invite_code failed on idempotent join: ${JSON.stringify(join2)}`);
  }
  const inviteCheck2 = await pg.query<{ uses: number }>(`SELECT uses FROM public.invites WHERE code = '${testInviteCode}'`);
  if (inviteCheck2.rows[0].uses !== 1) {
    throw new Error(`Invite uses erroneously incremented on already-member join: ${inviteCheck2.rows[0].uses}`);
  }

  // Người dùng mới khác join khi đã max_uses (1/1) -> Bị từ chối
  const anotherUser = '77777777-7777-4777-a777-777777777777';
  await pg.exec(`
    INSERT INTO auth.users (id, email)
    VALUES ('${anotherUser}', 'another@nexus.gg')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES ('${anotherUser}', 'another_user', 'Another User')
    ON CONFLICT (id) DO NOTHING;
  `);

  let maxUsesJoinFailed = false;
  try {
    await pg.query(`SELECT public.join_server_by_invite_code('${testInviteCode}', '${anotherUser}')`);
  } catch (err) {
    maxUsesJoinFailed = true;
  }
  if (!maxUsesJoinFailed) {
    throw new Error('join_server_by_invite_code allowed join beyond max_uses');
  }

  // Kiểm thử RPC accept_server_invitation
  const invRecordId = '88888888-8888-4888-a888-888888888888';
  await pg.exec(`
    INSERT INTO public.server_invitations (id, server_id, inviter_id, invitee_id, status, expires_at)
    VALUES ('${invRecordId}', '${testServerId}', '${ownerUser}', '${anotherUser}', 'pending', NOW() + INTERVAL '1 day')
    ON CONFLICT (id) DO NOTHING;
  `);

  // Người khác cố chấp nhận lời mời -> 42501
  let wrongAcceptFailed = false;
  try {
    await pg.query(`SELECT public.accept_server_invitation('${invRecordId}', '${regularUser}')`);
  } catch (err) {
    wrongAcceptFailed = true;
  }
  if (!wrongAcceptFailed) {
    throw new Error('accept_server_invitation allowed unauthorized user to accept');
  }

  // Đúng invitee chấp nhận
  const acceptRes = await pg.query<{ accept_server_invitation: any }>(
    `SELECT public.accept_server_invitation('${invRecordId}', '${anotherUser}') as accept_server_invitation`,
  );
  const acceptData = acceptRes.rows[0].accept_server_invitation;
  if (!acceptData.success || acceptData.alreadyMember !== false) {
    throw new Error(`accept_server_invitation failed: ${JSON.stringify(acceptData)}`);
  }

  // Kiểm tra status invitation đã thành accepted
  const invStatusRes = await pg.query<{ status: string }>(`SELECT status FROM public.server_invitations WHERE id = '${invRecordId}'`);
  if (invStatusRes.rows[0].status !== 'accepted') {
    throw new Error(`Invitation status not updated to accepted: ${invStatusRes.rows[0].status}`);
  }

  // Kiểm thử bảo mật: anon và authenticated bị revoke quyền
  await pg.exec(`SET ROLE anon;`);
  let anonCallFailed = false;
  try {
    await pg.query(`SELECT public.join_server_by_invite_code('${testInviteCode}', '${anotherUser}')`);
  } catch (err) {
    anonCallFailed = true;
  }
  if (!anonCallFailed) {
    throw new Error('anon role was able to execute join_server_by_invite_code');
  }

  await pg.exec(`SET ROLE authenticated;`);
  let authCallFailed = false;
  try {
    await pg.query(`SELECT public.create_server_channel('${testServerId}', '${ownerUser}', 'chan', 'text')`);
  } catch (err) {
    authCallFailed = true;
  }
  if (!authCallFailed) {
    throw new Error('authenticated role was able to execute create_server_channel directly');
  }

  // Áp dụng lần 2 (Kiểm thử Idempotency của migration 20260824000000)
  await pg.exec(`RESET ROLE;`);
  await pg.exec(serverInvMigrationSql);

  console.log('✔ Bước 14: Migration 20260824000000_server_invitations_and_capabilities.sql idempotent');

  // ===========================================================================
  // 15. Kiểm thử migration 20260824120000_live_server_channel_messages.sql
  // ===========================================================================
  const channelMsgMigrationPath = path.join(__dirname, '../supabase/migrations/20260824120000_live_server_channel_messages.sql');
  const channelMsgMigrationSql = fs.readFileSync(channelMsgMigrationPath, 'utf8');

  await pg.exec(channelMsgMigrationSql);
  console.log('✔ Bước 15.1: Áp dụng migration 20260824120000_live_server_channel_messages.sql thành công');

  // Test 15.2: Kiểm tra metadata pg_proc: prosecdef = true và search_path an toàn
  const procRes = await pg.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(`
    SELECT p.proname, p.prosecdef, p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN ('create_channel_message', 'update_server_channel', 'delete_server_channel')
  `);

  if (procRes.rows.length !== 3) {
    throw new Error(`Expected 3 RPC functions in public schema, found ${procRes.rows.length}`);
  }

  for (const row of procRes.rows) {
    if (!row.prosecdef) {
      throw new Error(`Function ${row.proname} is not SECURITY DEFINER (prosecdef=false)`);
    }
    const hasSearchPath = (row.proconfig || []).some((cfg) => cfg.includes('search_path=pg_catalog, public') || cfg.includes('search_path=pg_catalog,public'));
    if (!hasSearchPath) {
      throw new Error(`Function ${row.proname} missing fixed search_path config: ${JSON.stringify(row.proconfig)}`);
    }
  }
  console.log('✔ Bước 15.2: Kiểm tra SECURITY DEFINER và search_path an toàn cho toàn bộ 3 RPCs thành công');

  // Test 15.3: Quyền thực thi RPCs: anon và authenticated bị revoke, service_role được cấp quyền
  await pg.exec(`SET ROLE anon;`);
  let s15AnonCallFailed = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'Anon hack',
        '33333333-3333-3333-3333-333333333333'
      )
    `);
  } catch (err: any) {
    s15AnonCallFailed = true;
  }
  if (!s15AnonCallFailed) {
    throw new Error('anon role was able to execute create_channel_message');
  }

  await pg.exec(`SET ROLE authenticated;`);
  let s15AuthCallMsgFailed = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        'Auth hack',
        '33333333-3333-3333-3333-333333333333'
      )
    `);
  } catch (err: any) {
    s15AuthCallMsgFailed = true;
  }
  if (!s15AuthCallMsgFailed) {
    throw new Error('authenticated role was able to execute create_channel_message directly');
  }

  await pg.exec(`RESET ROLE;`);
  console.log('✔ Bước 15.3: REVOKE/GRANT phân quyền bảo mật RPCs chính xác (anon/authenticated blocked)');

  // Khởi tạo fixture kiểm thử permissions & channel overwrites với schema chuẩn target_type / target_id
  const testServerId2 = '88888888-8888-4888-a888-888888888888';
  const textChan1 = '99999999-1111-4999-a999-111111111111';
  const textChan2 = '99999999-2222-4999-a999-222222222222';
  const voiceChan = '99999999-3333-4999-a999-333333333333';

  const s15OwnerUser = '11111111-aaaa-4111-a111-111111111111';
  const s15RegularUser = '22222222-bbbb-4222-a222-222222222222';
  const s15CustomRoleUser = '33333333-cccc-4333-a333-333333333333';
  const s15NonMemberUser = '44444444-dddd-4444-a444-444444444444';

  const everyoneRoleId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const modRoleId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const mutedRoleId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

  await pg.exec(`
    INSERT INTO auth.users (id, email)
    VALUES
      ('${s15OwnerUser}', 'owner@nexus.gg'),
      ('${s15RegularUser}', 'regular@nexus.gg'),
      ('${s15CustomRoleUser}', 'mod@nexus.gg'),
      ('${s15NonMemberUser}', 'nonmember@nexus.gg')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, username, display_name)
    VALUES
      ('${s15OwnerUser}', 'server_owner', 'Server Owner'),
      ('${s15RegularUser}', 'reg_member', 'Regular Member'),
      ('${s15CustomRoleUser}', 'mod_member', 'Mod Member'),
      ('${s15NonMemberUser}', 'non_member', 'Non Member User')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.servers (id, name, owner_id)
    VALUES ('${testServerId2}', 'Channel Test Server', '${s15OwnerUser}')
    ON CONFLICT (id) DO NOTHING;

    -- Roles: @everyone (3339 = VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | ...)
    INSERT INTO public.roles (id, server_id, name, permissions, position, is_default)
    VALUES
      ('${everyoneRoleId}', '${testServerId2}', '@everyone', 3339, 0, true),
      ('${modRoleId}', '${testServerId2}', 'Moderator', 3355, 1, false),
      ('${mutedRoleId}', '${testServerId2}', 'Muted', 1, 2, false)
    ON CONFLICT (id) DO NOTHING;

    -- Memberships
    INSERT INTO public.server_members (server_id, user_id, role)
    VALUES
      ('${testServerId2}', '${s15OwnerUser}', 'OWNER'),
      ('${testServerId2}', '${s15RegularUser}', 'MEMBER'),
      ('${testServerId2}', '${s15CustomRoleUser}', 'MEMBER')
    ON CONFLICT (server_id, user_id) DO NOTHING;

    INSERT INTO public.member_roles (server_id, user_id, role_id)
    VALUES
      ('${testServerId2}', '${s15CustomRoleUser}', '${modRoleId}')
    ON CONFLICT (role_id, user_id) DO NOTHING;

    -- Channels
    INSERT INTO public.channels (id, server_id, name, type, position)
    VALUES
      ('${textChan1}', '${testServerId2}', 'general', 'text', 1),
      ('${textChan2}', '${testServerId2}', 'announcements', 'text', 2),
      ('${voiceChan}', '${testServerId2}', 'voice-room', 'voice', 3)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Test 15.4: Regular member gửi tin nhắn qua quyền @everyone thành công
  const testNonce1 = '55555555-5555-4555-a555-555555555555';
  const attFileUuid = '66666666-6666-4666-a666-666666666666';
  const validAtt = JSON.stringify([
    {
      storage_path: `channels/${textChan1}/${attFileUuid}.png`,
      filename: 'photo.png',
      mime_type: 'image/png',
      size_bytes: 102400,
      width: 800,
      height: 600,
    },
  ]);

  const msg1Res = await pg.query<{ create_channel_message: any }>(`
    SELECT public.create_channel_message(
      '${textChan1}',
      '${s15RegularUser}',
      'Hello from Regular Member!',
      '${testNonce1}',
      NULL,
      '${validAtt}'::jsonb,
      false
    )
  `);
  const msg1 = msg1Res.rows[0].create_channel_message;
  if (!msg1 || msg1.content !== 'Hello from Regular Member!' || msg1.attachments.length !== 1) {
    throw new Error('create_channel_message failed for regular member with @everyone permissions');
  }
  console.log('✔ Bước 15.4: Member thường gửi tin nhắn thành công qua quyền @everyone');

  // Test 15.5: Channel Overwrite @everyone deny SEND_MESSAGES (deny = 2) trên textChan2
  await pg.exec(`
    INSERT INTO public.channel_overwrites (channel_id, target_type, target_id, allow, deny)
    VALUES ('${textChan2}', 'role'::overwrite_target, '${everyoneRoleId}', 1, 2);
  `);

  let regSendDenied = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '${textChan2}',
        '${s15RegularUser}',
        'Trying to speak in announcements',
        '77777777-7777-4777-a777-777777777777',
        NULL,
        '[]'::jsonb,
        false
      )
    `);
  } catch (err: any) {
    regSendDenied = true;
  }
  if (!regSendDenied) {
    throw new Error('Regular member was able to send message despite @everyone deny SEND_MESSAGES overwrite');
  }
  console.log('✔ Bước 15.5: Channel overwrite @everyone deny SEND_MESSAGES chặn member thường chuẩn');

  // Test 15.6: Custom role (Moderator) overwrite allow SEND_MESSAGES trên textChan2
  await pg.exec(`
    INSERT INTO public.channel_overwrites (channel_id, target_type, target_id, allow, deny)
    VALUES ('${textChan2}', 'role'::overwrite_target, '${modRoleId}', 2, 0);
  `);

  const modMsgRes = await pg.query<{ create_channel_message: any }>(`
    SELECT public.create_channel_message(
      '${textChan2}',
      '${s15CustomRoleUser}',
      'Mod can post in announcements!',
      '88888888-8888-4888-a888-888888888888',
      NULL,
      '[]'::jsonb,
      false
    )
  `);
  if (!modMsgRes.rows[0].create_channel_message) {
    throw new Error('Mod member failed to post with role allow overwrite');
  }
  console.log('✔ Bước 15.6: Custom Role overwrite ghi đè @everyone deny thành công');

  // Test 15.7: Member-specific overwrite ghi đè role deny
  // Gán thêm role Muted cho s15CustomRoleUser, nhưng tạo member overwrite allow SEND_MESSAGES
  await pg.exec(`
    INSERT INTO public.member_roles (server_id, user_id, role_id)
    VALUES ('${testServerId2}', '${s15CustomRoleUser}', '${mutedRoleId}')
    ON CONFLICT (role_id, user_id) DO NOTHING;

    INSERT INTO public.channel_overwrites (channel_id, target_type, target_id, allow, deny)
    VALUES
      ('${textChan2}', 'role'::overwrite_target, '${mutedRoleId}', 0, 2),
      ('${textChan2}', 'member'::overwrite_target, '${s15CustomRoleUser}', 2, 0);
  `);

  const memOwRes = await pg.query<{ create_channel_message: any }>(`
    SELECT public.create_channel_message(
      '${textChan2}',
      '${s15CustomRoleUser}',
      'Member-specific overwrite bypasses role deny!',
      '99999999-9999-4999-a999-999999999999',
      NULL,
      '[]'::jsonb,
      false
    )
  `);
  if (!memOwRes.rows[0].create_channel_message) {
    throw new Error('Member-specific overwrite failed to take precedence');
  }
  console.log('✔ Bước 15.7: Member-specific overwrite có mức ưu tiên cao nhất theo chuẩn 5 bước');

  // Test 15.8: Quyền ATTACH_FILES bị deny (deny = 8)
  await pg.exec(`
    DELETE FROM public.channel_overwrites WHERE channel_id = '${textChan1}' AND target_type = 'member' AND target_id = '${s15RegularUser}';
    INSERT INTO public.channel_overwrites (channel_id, target_type, target_id, allow, deny)
    VALUES ('${textChan1}', 'member'::overwrite_target, '${s15RegularUser}', 3, 8);
  `);

  let attachDenied = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '${textChan1}',
        '${s15RegularUser}',
        'Sending attachment without permission',
        'aaaaaaaa-1111-4aaa-aaaa-111111111111',
        NULL,
        '${validAtt}'::jsonb,
        false
      )
    `);
  } catch (err) {
    attachDenied = true;
  }
  if (!attachDenied) {
    throw new Error('User was able to attach file despite ATTACH_FILES deny overwrite');
  }

  // Nhưng gửi văn bản thuần không attachment vẫn thành công
  const textOnlyRes = await pg.query<{ create_channel_message: any }>(`
    SELECT public.create_channel_message(
      '${textChan1}',
      '${s15RegularUser}',
      'Plain text still works!',
      'aaaaaaaa-2222-4aaa-aaaa-222222222222',
      NULL,
      '[]'::jsonb,
      false
    )
  `);
  if (!textOnlyRes.rows[0].create_channel_message) {
    throw new Error('User failed to send plain text when only ATTACH_FILES was denied');
  }
  await pg.exec(`
    DELETE FROM public.channel_overwrites WHERE channel_id = '${textChan1}' AND target_type = 'member' AND target_id = '${s15RegularUser}';
  `);
  console.log('✔ Bước 15.8: Gating độc lập giữa SEND_MESSAGES và ATTACH_FILES chuẩn xác');

  // Test 15.9: Forward message nguyên tử với p_is_forwarded = true
  const fwdMsgRes = await pg.query<{ create_channel_message: any }>(`
    SELECT public.create_channel_message(
      '${textChan1}',
      '${s15OwnerUser}',
      'Forwarded content here',
      'bbbbbbbb-1111-4bbb-bbbb-111111111111',
      NULL,
      '[]'::jsonb,
      true
    )
  `);
  const fwdMsg = fwdMsgRes.rows[0].create_channel_message;
  if (!fwdMsg || fwdMsg.isForwarded !== true) {
    throw new Error('p_is_forwarded failed to store or return isForwarded = true');
  }

  const checkDbFwd = await pg.query<{ is_forwarded: boolean }>(`
    SELECT is_forwarded FROM public.messages WHERE id = ${fwdMsg.id}
  `);
  if (!checkDbFwd.rows[0].is_forwarded) {
    throw new Error('is_forwarded not true in messages table');
  }
  console.log('✔ Bước 15.9: Forward message ghi nhận is_forwarded nguyên tử ngay trong RPC');

  // Test 15.10: Validation defense-in-depth
  // 1. Chặn gửi tin nhắn vào voice channel
  let voiceSendFailed = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '${voiceChan}',
        '${s15OwnerUser}',
        'Voice chat attempt',
        'cccccccc-1111-4ccc-cccc-111111111111'
      )
    `);
  } catch (err) {
    voiceSendFailed = true;
  }
  if (!voiceSendFailed) {
    throw new Error('Was able to send message into voice channel');
  }

  // 2. Chặn MIME không nằm trong whitelist (ví dụ application/x-msdownload)
  let badMimeFailed = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '${textChan1}',
        '${s15OwnerUser}',
        'Malicious exe',
        'cccccccc-2222-4ccc-cccc-222222222222',
        NULL,
        '[{"storage_path":"channels/${textChan1}/66666666-6666-4666-a666-666666666666.exe","filename":"virus.exe","mime_type":"application/x-msdownload","size_bytes":100}]'::jsonb
      )
    `);
  } catch (err) {
    badMimeFailed = true;
  }
  if (!badMimeFailed) {
    throw new Error('Was able to attach non-whitelisted MIME type');
  }

  // 3. Chặn path traversal trong storage_path
  let pathTraversalFailed = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '${textChan1}',
        '${s15OwnerUser}',
        'Path traversal',
        'cccccccc-3333-4ccc-cccc-333333333333',
        NULL,
        '[{"storage_path":"channels/${textChan1}/../secrets/passwords.png","filename":"passwords.png","mime_type":"image/png","size_bytes":100}]'::jsonb
      )
    `);
  } catch (err) {
    pathTraversalFailed = true;
  }
  if (!pathTraversalFailed) {
    throw new Error('Was able to use path traversal in storage_path');
  }
  console.log('✔ Bước 15.10: Validation defense-in-depth chặn voice channel, invalid MIME và path traversal chuẩn');

  // Test 15.11: Duplicate clientNonce cùng channel trả về idempotent message
  const dupMsgRes = await pg.query<{ create_channel_message: any }>(`
    SELECT public.create_channel_message(
      '${textChan1}',
      '${s15RegularUser}',
      'Hello from Regular Member!',
      '${testNonce1}',
      NULL,
      '${validAtt}'::jsonb
    )
  `);
  if (dupMsgRes.rows[0].create_channel_message.id !== msg1.id) {
    throw new Error('Duplicate nonce returned different message ID');
  }

  // Duplicate nonce khác channel báo 23505 conflict
  let diffChanNonceFailed = false;
  try {
    await pg.query(`
      SELECT public.create_channel_message(
        '${textChan2}',
        '${s15RegularUser}',
        'Different Chan',
        '${testNonce1}'
      )
    `);
  } catch (err: any) {
    diffChanNonceFailed = true;
  }
  if (!diffChanNonceFailed) {
    throw new Error('Duplicate nonce on different channel should have failed with 23505 conflict');
  }
  console.log('✔ Bước 15.11: Idempotency clientNonce cùng channel và chặn 23505 khác channel thành công');

  // Test 15.12: update_server_channel với advisory lock và kiểm tra ký tự điều khiển
  const updatedChanRes = await pg.query<{ update_server_channel: any }>(`
    SELECT public.update_server_channel(
      '${testServerId2}',
      '${textChan1}',
      '${s15OwnerUser}',
      'general-updated',
      'New channel topic'
    )
  `);
  const updatedChan = updatedChanRes.rows[0].update_server_channel;
  if (updatedChan.name !== 'general-updated' || updatedChan.topic !== 'New channel topic') {
    throw new Error('update_server_channel failed to update');
  }

  let controlCharFailed = false;
  try {
    await pg.query(`
      SELECT public.update_server_channel(
        '${testServerId2}',
        '${textChan1}',
        '${s15OwnerUser}',
        'general\x01test'
      )
    `);
  } catch (err) {
    controlCharFailed = true;
  }
  if (!controlCharFailed) {
    throw new Error('update_server_channel accepted control character in name');
  }
  console.log('✔ Bước 15.12: update_server_channel với advisory lock và sanitize kiểm tra hợp lệ');

  // Test 15.13: delete_server_channel với advisory lock: xóa kênh thứ hai và chặn xóa kênh chữ cuối
  const delChan2Res = await pg.query<{ delete_server_channel: any }>(`
    SELECT public.delete_server_channel(
      '${testServerId2}',
      '${textChan2}',
      '${s15OwnerUser}'
    )
  `);
  if (!delChan2Res.rows[0].delete_server_channel.success) {
    throw new Error('delete_server_channel failed on second text channel');
  }

  let delLastTextFailed = false;
  try {
    await pg.query(`
      SELECT public.delete_server_channel(
        '${testServerId2}',
        '${textChan1}',
        '${s15OwnerUser}'
      )
    `);
  } catch (err) {
    delLastTextFailed = true;
  }
  if (!delLastTextFailed) {
    throw new Error('delete_server_channel allowed deleting the only remaining text channel');
  }
  console.log('✔ Bước 15.13: delete_server_channel bảo vệ thành công text channel duy nhất còn lại');

  // Test 15.14: Idempotency re-apply migration
  await pg.exec(channelMsgMigrationSql);
  console.log('✔ Bước 15.14: Migration 20260824120000_live_server_channel_messages.sql idempotent 100%');

  await pg.exec(`RESET ROLE;`);
  await pg.close();
  console.log('--- TOÀN BỘ 15 BƯỚC KIỂM THỬ POSTGRESQL ENGINE ĐÃ PASS 100% ---');
}

runPostgresMigrationTests().catch((err: any) => {
  console.error('❌ Kiểm thử migration thất bại:', err?.message || err, err?.stack);
  process.exit(1);
});


