import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

describe('Local PostgreSQL Migration Test (Real Ephemeral Postgres Engine)', () => {
  let pg: PGlite;

  const userA = '11111111-1111-4111-a111-111111111111';
  const userB = '22222222-2222-4222-a222-222222222222';
  const outsider = '99999999-9999-4999-a999-999999999999';
  const convId = '33333333-3333-4333-a333-333333333333';

  beforeAll(async () => {
    pg = new PGlite();

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

    // 3. Seed dữ liệu cơ bản cho test
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
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  it('1. Migration chạy thành công trên PostgreSQL engine thật', async () => {
    const migrationPath = path.resolve(
      __dirname,
      '../supabase/migrations/20260823150000_add_message_forwarded.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Chạy toàn bộ migration SQL
    await expect(pg.exec(sql)).resolves.not.toThrow();

    // Kiểm tra cột is_forwarded đã tồn tại
    const colRes = await pg.query(`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'is_forwarded';
    `);
    expect(colRes.rows.length).toBe(1);
    expect((colRes.rows[0] as any).column_name).toBe('is_forwarded');
  });

  it('2. Function create_forwarded_message được tạo đúng signature và security attributes', async () => {
    const fnRes = await pg.query(`
      SELECT proname, prosecdef, provolatile, pronargs
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'create_forwarded_message';
    `);
    expect(fnRes.rows.length).toBe(1);
    expect((fnRes.rows[0] as any).proname).toBe('create_forwarded_message');
    expect((fnRes.rows[0] as any).prosecdef).toBe(true); // SECURITY DEFINER
    expect((fnRes.rows[0] as any).pronargs).toBe(5); // 5 parameters
  });

  it('3. Anon và Authenticated roles bị từ chối thực thi function (Permission Denied)', async () => {
    // Thử gọi với role anon
    await pg.exec(`SET ROLE anon;`);
    await expect(
      pg.query(`
        SELECT * FROM public.create_forwarded_message(
          '${userA}',
          '${convId}',
          'Test anon',
          '44444444-4444-4444-a444-444444444444'::uuid
        );
      `),
    ).rejects.toThrow(/permission denied for function create_forwarded_message/i);

    // Thử gọi với role authenticated
    await pg.exec(`SET ROLE authenticated;`);
    await expect(
      pg.query(`
        SELECT * FROM public.create_forwarded_message(
          '${userA}',
          '${convId}',
          'Test auth',
          '44444444-4444-4444-a444-444444444444'::uuid
        );
      `),
    ).rejects.toThrow(/permission denied for function create_forwarded_message/i);

    // Reset role về service_role / postgres
    await pg.exec(`RESET ROLE;`);
  });

  it('4. Service role gọi thành công: message và attachments insert nguyên tử (IDs dạng string)', async () => {
    await pg.exec(`SET ROLE service_role;`);

    const nonce = '55555555-5555-4555-a555-555555555555';
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

    const res = await pg.query(
      `
      SELECT * FROM public.create_forwarded_message(
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        $5::jsonb
      );
    `,
      [userA, convId, 'Tin nhắn chuyển tiếp kèm ảnh', nonce, attachments],
    );

    await pg.exec(`RESET ROLE;`);

    expect(res.rows.length).toBe(1);
    const row = res.rows[0] as any;
    expect(typeof row.message_id).toBe('string');
    expect(row.conversation_id).toBe(convId);
    expect(row.author_id).toBe(userA);
    expect(row.content).toBe('Tin nhắn chuyển tiếp kèm ảnh');
    expect(row.is_forwarded).toBe(true);
    expect(row.client_nonce).toBe(nonce);

    // Kiểm tra attachments jsonb trả về
    const atts = Array.isArray(row.attachments)
      ? row.attachments
      : JSON.parse(row.attachments as string);
    expect(atts.length).toBe(1);
    expect(typeof atts[0].id).toBe('string');
    expect(typeof atts[0].message_id).toBe('string');
    expect(atts[0].filename).toBe('file1.png');
    expect(atts[0].size_bytes).toBe(2048);

    // Kiểm tra database thực tế đã lưu cả message và attachment
    const dbMsg = await pg.query(`SELECT * FROM public.messages WHERE id = $1;`, [row.message_id]);
    expect(dbMsg.rows.length).toBe(1);
    expect((dbMsg.rows[0] as any).is_forwarded).toBe(true);

    const dbAtt = await pg.query(`SELECT * FROM public.attachments WHERE message_id = $1;`, [
      row.message_id,
    ]);
    expect(dbAtt.rows.length).toBe(1);
    expect((dbAtt.rows[0] as any).filename).toBe('file1.png');
  });

  it('5. Validate p_client_nonce IS NULL -> Ném lỗi 22023', async () => {
    await pg.exec(`SET ROLE service_role;`);

    await expect(
      pg.query(`
        SELECT * FROM public.create_forwarded_message(
          '${userA}',
          '${convId}',
          'Missing nonce',
          NULL
        );
      `),
    ).rejects.toThrow(/Client nonce is required/i);

    await pg.exec(`RESET ROLE;`);
  });

  it('6. Validate non-member (outsider) -> Ném lỗi 42501', async () => {
    await pg.exec(`SET ROLE service_role;`);

    await expect(
      pg.query(`
        SELECT * FROM public.create_forwarded_message(
          '${outsider}',
          '${convId}',
          'Outsider content',
          '66666666-6666-4666-a666-666666666666'::uuid
        );
      `),
    ).rejects.toThrow(/is not a participant of target conversation/i);

    await pg.exec(`RESET ROLE;`);
  });

  it('7. Validate storage_path prefix conversations/<conv_id>/ -> Ném lỗi 22023', async () => {
    await pg.exec(`SET ROLE service_role;`);

    const invalidPrefixAtts = JSON.stringify([
      {
        storage_path: `conversations/other-uuid-999/malicious.png`,
        filename: 'malicious.png',
        mime_type: 'image/png',
        size_bytes: 100,
        width: 100,
        height: 100,
      },
    ]);

    await expect(
      pg.query(
        `
        SELECT * FROM public.create_forwarded_message(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::uuid,
          $5::jsonb
        );
      `,
        [userA, convId, 'Invalid path prefix', '77777777-7777-4777-a777-777777777777', invalidPrefixAtts],
      ),
    ).rejects.toThrow(/Invalid attachment metadata/i);

    await pg.exec(`RESET ROLE;`);
  });

  it('8. Validate attachment metadata (size_bytes <= 0, âm width/height) -> Ném lỗi 22023', async () => {
    await pg.exec(`SET ROLE service_role;`);

    // size_bytes <= 0
    const zeroSizeAtts = JSON.stringify([
      {
        storage_path: `conversations/${convId}/empty.txt`,
        filename: 'empty.txt',
        mime_type: 'text/plain',
        size_bytes: 0,
      },
    ]);

    await expect(
      pg.query(
        `
        SELECT * FROM public.create_forwarded_message(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::uuid,
          $5::jsonb
        );
      `,
        [userA, convId, 'Zero size att', '88888888-8888-4888-a888-888888888888', zeroSizeAtts],
      ),
    ).rejects.toThrow(/Invalid attachment metadata/i);

    // width <= 0
    const negativeDimAtts = JSON.stringify([
      {
        storage_path: `conversations/${convId}/bad_dim.png`,
        filename: 'bad_dim.png',
        mime_type: 'image/png',
        size_bytes: 500,
        width: -50,
        height: 100,
      },
    ]);

    await expect(
      pg.query(
        `
        SELECT * FROM public.create_forwarded_message(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::uuid,
          $5::jsonb
        );
      `,
        [userA, convId, 'Negative width', '99999999-8888-4888-a888-888888888888', negativeDimAtts],
      ),
    ).rejects.toThrow(/Invalid attachment metadata/i);

    await pg.exec(`RESET ROLE;`);
  });

  it('9. Lỗi attachment rollback toàn bộ message (Atomic rollback)', async () => {
    await pg.exec(`SET ROLE service_role;`);

    const failNonce = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    // Đính kèm 1 attachment hợp lệ và 1 attachment không hợp lệ (size <= 0)
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
        size_bytes: -10, // Sẽ kích hoạt lỗi
      },
    ]);

    // Gọi RPC và mong đợi thất bại
    await expect(
      pg.query(
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
      ),
    ).rejects.toThrow(/Invalid attachment metadata/i);

    await pg.exec(`RESET ROLE;`);

    // Kiểm tra trong database: KHÔNG CÓ message nào được tạo với failNonce
    const checkMsg = await pg.query(
      `SELECT * FROM public.messages WHERE author_id = $1 AND client_nonce = $2;`,
      [userA, failNonce],
    );
    expect(checkMsg.rows.length).toBe(0);
  });

  it('10. Concurrent race condition: Nonce đã tồn tại sẽ raise 23505 (unique_violation)', async () => {
    await pg.exec(`SET ROLE service_role;`);

    const nonce = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';

    // Lần 1: Thành công
    const firstCall = await pg.query(
      `
      SELECT * FROM public.create_forwarded_message(
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        '[]'::jsonb
      );
    `,
      [userA, convId, 'Initial message', nonce],
    );
    expect(firstCall.rows.length).toBe(1);

    // Lần 2: Cùng client_nonce -> Phải raise 23505 unique violation
    await expect(
      pg.query(
        `
        SELECT * FROM public.create_forwarded_message(
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::uuid,
          '[]'::jsonb
        );
      `,
        [userA, convId, 'Duplicate message', nonce],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "idx_messages_nonce"/i);

    await pg.exec(`RESET ROLE;`);
  });
});
