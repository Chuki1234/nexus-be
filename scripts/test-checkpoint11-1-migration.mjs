import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runCheckpoint11_1_Tests() {
  console.log('--- BẮT ĐẦU KIỂM THỬ TOÀN DIỆN CHECKPOINT 11.1 (PGLITE) ---');
  const db = new PGlite();

  // 1. Setup base schema & mock Supabase roles
  console.log('1. Khởi tạo schema cơ sở & roles...');
  await db.exec(`
    do $$ begin
      create role service_role;
    exception when others then null;
    end $$;
    do $$ begin
      create role authenticated;
    exception when others then null;
    end $$;
    do $$ begin
      create role anon;
    exception when others then null;
    end $$;

    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique
    );

    do $$ begin
      create type public.channel_type as enum ('text', 'voice');
    exception when duplicate_object then null;
    end $$;

    create table if not exists public.servers (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      template_id text,
      icon_url text,
      owner_id uuid not null references auth.users(id) on delete cascade
    );

    create table if not exists public.channels (
      id uuid primary key default gen_random_uuid(),
      server_id uuid not null references public.servers(id) on delete cascade,
      name text not null,
      type public.channel_type not null default 'text',
      topic text,
      position integer not null default 0
    );

    create unique index if not exists idx_channels_server_lower_name
      on public.channels (server_id, lower(name));

    create table if not exists public.server_members (
      server_id uuid not null references public.servers(id) on delete cascade,
      user_id uuid not null references auth.users(id) on delete cascade,
      role text not null default 'MEMBER',
      primary key (server_id, user_id)
    );

    create table if not exists public.roles (
      id uuid primary key default gen_random_uuid(),
      server_id uuid not null references public.servers(id) on delete cascade,
      name text not null,
      permissions bigint not null default 0,
      position integer not null default 0,
      is_default boolean not null default false
    );

    create table if not exists public.member_roles (
      server_id uuid not null references public.servers(id) on delete cascade,
      user_id uuid not null references auth.users(id) on delete cascade,
      role_id uuid not null references public.roles(id) on delete cascade,
      primary key (server_id, user_id, role_id)
    );

    create table if not exists public.invites (
      code text primary key,
      server_id uuid not null references public.servers(id) on delete cascade,
      channel_id uuid references public.channels(id) on delete set null,
      inviter_id uuid not null references auth.users(id) on delete cascade,
      max_uses integer,
      uses integer not null default 0,
      expires_at timestamptz
    );
  `);
  console.log('✓ Base schema đã sẵn sàng.');

  // 2. Apply Checkpoint 11 migration
  console.log('2. Áp dụng Migration Checkpoint 11...');
  const mig1Path = path.resolve(__dirname, '../supabase/migrations/20260824000000_server_invitations_and_capabilities.sql');
  await db.exec(fs.readFileSync(mig1Path, 'utf8'));

  // Seed sample server with legacy 3339 @everyone role + custom role with CREATE_INVITE (256)
  const ownerId = '11111111-1111-1111-1111-111111111111';
  const memberId = '22222222-2222-2222-2222-222222222222';
  const adminId = '33333333-3333-3333-3333-333333333333';
  const srv1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const everyoneRoleId = 'bbbbbbbb-1111-bbbb-1111-bbbbbbbbbbbb';
  const customRoleId = 'bbbbbbbb-2222-bbbb-2222-bbbbbbbbbbbb';

  await db.exec(`
    insert into auth.users (id, email) values
      ('${ownerId}', 'owner@nexuscord.app'),
      ('${memberId}', 'member@nexuscord.app'),
      ('${adminId}', 'admin@nexuscord.app');

    insert into public.servers (id, name, owner_id)
    values ('${srv1}', 'Server Cũ', '${ownerId}');

    insert into public.server_members (server_id, user_id, role) values
      ('${srv1}', '${ownerId}', 'OWNER'),
      ('${srv1}', '${memberId}', 'MEMBER'),
      ('${srv1}', '${adminId}', 'MEMBER');

    insert into public.roles (id, server_id, name, permissions, is_default) values
      ('${everyoneRoleId}', '${srv1}', '@everyone', 3339, true),
      ('${customRoleId}', '${srv1}', 'VIP Inviter', 256, false);

    insert into public.member_roles (server_id, user_id, role_id)
    values ('${srv1}', '${adminId}', '${customRoleId}');
  `);

  // 3. Apply Checkpoint 11.1 migration
  console.log('3. Áp dụng Migration Checkpoint 11.1...');
  const mig2Path = path.resolve(__dirname, '../supabase/migrations/20260824100000_adjust_default_invite_and_server_lifecycle.sql');
  await db.exec(fs.readFileSync(mig2Path, 'utf8'));
  console.log('✓ Migration Checkpoint 11.1 áp dụng thành công.');

  // TEST 1: @everyone permissions được cập nhật thành 3083, custom role 256 giữ nguyên & Bit-level verification
  console.log('\n--- TEST 1: Kiểm tra quyền @everyone mặc định (3083) & Custom Role (256) & Bit-level ---');
  const roleCheck = await db.query(`select id, name, permissions, is_default from public.roles where server_id = '${srv1}';`);
  const everyoneRole = roleCheck.rows.find((r) => r.is_default);
  const customRole = roleCheck.rows.find((r) => !r.is_default);

  console.log('@everyone permissions:', everyoneRole.permissions);
  console.log('custom role permissions:', customRole.permissions);

  const everyonePerms = BigInt(everyoneRole.permissions);
  if (everyonePerms !== 3083n) {
    throw new Error(`TEST 1 FAILED: Expected @everyone permissions to be 3083, got ${everyoneRole.permissions}`);
  }
  if (BigInt(customRole.permissions) !== 256n) {
    throw new Error(`TEST 1 FAILED: Custom role permissions should remain 256, got ${customRole.permissions}`);
  }

  // Bit-level verification cho 3083n: VIEW_CHANNEL(1) | SEND_MESSAGES(2) | ATTACH_FILES(8) | CONNECT_VOICE(1024) | SPEAK_VOICE(2048)
  const expected3083 = 1n | 2n | 8n | 1024n | 2048n;
  if (everyonePerms !== expected3083) {
    throw new Error(`TEST 1 FAILED: 3083n does not equal (1|2|8|1024|2048)`);
  }
  if ((everyonePerms & 256n) !== 0n) {
    throw new Error(`TEST 1 FAILED: @everyone contains CREATE_INVITE (256n)!`);
  }
  if ((everyonePerms & 16n) !== 0n) {
    throw new Error(`TEST 1 FAILED: @everyone contains MANAGE_CHANNELS (16n)!`);
  }
  if ((everyonePerms & 512n) !== 0n) {
    throw new Error(`TEST 1 FAILED: @everyone contains MANAGE_SERVER (512n)!`);
  }
  if ((everyonePerms & 32n) !== 0n) {
    throw new Error(`TEST 1 FAILED: @everyone contains MANAGE_ROLES (32n)!`);
  }
  console.log('✓ TEST 1 PASSED: @everyone updated to 3083 and verified at bit-level (no 256, no 16, no 512)');

  // TEST 2: RPC create_server_with_template tạo @everyone với quyền 3083 và response shape chuẩn JSON array
  console.log('\n--- TEST 2: create_server_with_template Response Shape & Default Channel Array ---');
  
  // 2a. Template có danh sách kênh
  const createRes1 = await db.query(`
    select public.create_server_with_template(
      '${ownerId}',
      'Server Gaming',
      'gaming',
      '[{"name": "chung", "type": "text", "position": 0}, {"name": "Voice", "type": "voice", "position": 1}]'::jsonb
    ) as res;
  `);
  const srvData1 = createRes1.rows[0].res;
  if (!srvData1.server || !Array.isArray(srvData1.channels)) {
    throw new Error('TEST 2a FAILED: Response must contain server object and channels JSON array');
  }
  if (srvData1.channels.length !== 2) {
    throw new Error(`TEST 2a FAILED: Expected 2 channels, got ${srvData1.channels.length}`);
  }

  const newSrvId = srvData1.server.id;
  const newRoleCheck = await db.query(`select permissions from public.roles where server_id = '${newSrvId}' and is_default = true;`);
  if (BigInt(newRoleCheck.rows[0].permissions) !== 3083n) {
    throw new Error(`TEST 2a FAILED: New server @everyone role should have 3083 permissions, got ${newRoleCheck.rows[0].permissions}`);
  }

  // 2b. Template rỗng -> Fallback default channel nhánh jsonb_build_array
  const createRes2 = await db.query(`
    select public.create_server_with_template(
      '${ownerId}',
      'Server Rỗng Mẫu',
      null,
      '[]'::jsonb
    ) as res;
  `);
  const srvData2 = createRes2.rows[0].res;
  console.log('Default channel response shape:', srvData2);
  if (!srvData2.server || !Array.isArray(srvData2.channels)) {
    throw new Error('TEST 2b FAILED: Default channel fallback must return channels as a JSON array');
  }
  if (srvData2.channels.length !== 1 || srvData2.channels[0].name !== 'chung') {
    throw new Error(`TEST 2b FAILED: Default channel must be 1 text channel named 'chung', got ${JSON.stringify(srvData2.channels)}`);
  }
  console.log('✓ TEST 2 PASSED: create_server_with_template response shape verified (JSON array channels in both custom and default fallback branches)');

  // TEST 3: RPC leave_server
  console.log('\n--- TEST 3: RPC leave_server (Owner chặn 409, Member rời thành công & idempotent) ---');
  
  // 3a. Owner cố rời -> owner_cannot_leave
  const ownerLeaveRes = await db.query(`select public.leave_server('${srv1}', '${ownerId}') as res;`);
  console.log('Owner leave result:', ownerLeaveRes.rows[0].res);
  if (ownerLeaveRes.rows[0].res.success !== false || ownerLeaveRes.rows[0].res.reason !== 'owner_cannot_leave') {
    throw new Error('TEST 3a FAILED: Owner should be prevented from leaving server');
  }

  // 3b. Member rời -> Thành công
  const memberLeave1 = await db.query(`select public.leave_server('${srv1}', '${memberId}') as res;`);
  console.log('Member first leave result:', memberLeave1.rows[0].res);
  if (!memberLeave1.rows[0].res.success || memberLeave1.rows[0].res.alreadyLeft !== false) {
    throw new Error('TEST 3b FAILED: Member should successfully leave server');
  }
  const checkMemberInDb = await db.query(`select 1 from public.server_members where server_id = '${srv1}' and user_id = '${memberId}';`);
  if (checkMemberInDb.rows.length > 0) {
    throw new Error('TEST 3b FAILED: Member still exists in server_members table!');
  }

  // 3c. Member retry leave -> Idempotent
  const memberLeave2 = await db.query(`select public.leave_server('${srv1}', '${memberId}') as res;`);
  console.log('Member retry leave result:', memberLeave2.rows[0].res);
  if (!memberLeave2.rows[0].res.success || memberLeave2.rows[0].res.alreadyLeft !== true) {
    throw new Error('TEST 3c FAILED: Retry leave should return alreadyLeft: true');
  }
  console.log('✓ TEST 3 PASSED: leave_server handles Owner conflict, member removal, and idempotency');

  // TEST 4: RPC delete_server
  console.log('\n--- TEST 4: RPC delete_server (Non-owner 42501, Owner xóa thành công & trả memberUserIds) ---');

  // 4a. Non-owner cố xóa -> 42501 Forbidden
  try {
    await db.query(`select public.delete_server('${srv1}', '${adminId}');`);
    throw new Error('TEST 4a FAILED: Non-owner should have been rejected with 42501');
  } catch (err) {
    if (err.code === '42501' || err.message.includes('Chỉ chủ sở hữu')) {
      console.log('✓ TEST 4a PASSED: Non-owner delete rejected with 42501');
    } else {
      throw err;
    }
  }

  // 4b. Owner xóa -> Thành công & CASCADE xóa toàn bộ dependencies
  const deleteRes = await db.query(`select public.delete_server('${srv1}', '${ownerId}') as res;`);
  const delData = deleteRes.rows[0].res;
  console.log('Delete server result:', delData);
  if (!delData.success || !Array.isArray(delData.memberUserIds)) {
    throw new Error('TEST 4b FAILED: delete_server should return success: true and memberUserIds array');
  }
  if (!delData.memberUserIds.includes(ownerId) || !delData.memberUserIds.includes(adminId)) {
    throw new Error('TEST 4b FAILED: memberUserIds should contain server members before deletion');
  }

  const checkSrvDeleted = await db.query(`select 1 from public.servers where id = '${srv1}';`);
  const checkRolesDeleted = await db.query(`select 1 from public.roles where server_id = '${srv1}';`);
  const checkMembersDeleted = await db.query(`select 1 from public.server_members where server_id = '${srv1}';`);

  if (checkSrvDeleted.rows.length > 0 || checkRolesDeleted.rows.length > 0 || checkMembersDeleted.rows.length > 0) {
    throw new Error('TEST 4b FAILED: Database cascade deletion did not clean up all server rows!');
  }
  console.log('✓ TEST 4 PASSED: delete_server enforcement, member gathering, and CASCADE deletion verified');

  // TEST 5: Security role enforcement on new RPCs
  console.log('\n--- TEST 5: Security role enforcement (anon & authenticated denied, service_role allowed) ---');
  await db.exec(`set role anon;`);
  try {
    await db.query(`select public.delete_server('${newSrvId}', '${ownerId}');`);
    throw new Error('TEST 5a FAILED: anon should NOT be able to execute delete_server');
  } catch (err) {
    if (err.code === '42501') {
      console.log('✓ TEST 5a PASSED: anon denied execute on delete_server (42501)');
    } else {
      throw err;
    }
  }

  await db.exec(`set role authenticated;`);
  try {
    await db.query(`select public.leave_server('${newSrvId}', '${ownerId}');`);
    throw new Error('TEST 5b FAILED: authenticated should NOT be able to execute leave_server directly');
  } catch (err) {
    if (err.code === '42501') {
      console.log('✓ TEST 5b PASSED: authenticated denied execute on leave_server (42501)');
    } else {
      throw err;
    }
  }

  await db.exec(`set role service_role;`);
  const srvRoleDel = await db.query(`select public.delete_server('${newSrvId}', '${ownerId}') as res;`);
  if (!srvRoleDel.rows[0].res.success) {
    throw new Error('TEST 5c FAILED: service_role should be able to execute delete_server');
  }
  console.log('✓ TEST 5c PASSED: service_role successfully executed delete_server');

  await db.exec(`reset role;`);

  console.log('\n============================================================');
  console.log('TẤT CẢ CÁC TEST SUITES CHECKPOINT 11.1 ĐỀU PASS 100%!');
  console.log('============================================================');
}

runCheckpoint11_1_Tests().catch((err) => {
  console.error('LỖI KIỂM THỬ CHECKPOINT 11.1:', err);
  process.exit(1);
});
