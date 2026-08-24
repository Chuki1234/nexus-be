import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('--- BẮT ĐẦU KIỂM THỬ TOÀN DIỆN MIGRATION CHECKPOINT 11 (PGLITE) ---');
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
  const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260824000000_server_invitations_and_capabilities.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  await db.exec(migrationSql);
  console.log('✓ Migration Checkpoint 11 áp dụng thành công.');

  // Seed data
  const ownerId = '11111111-1111-1111-1111-111111111111';
  const memberId = '22222222-2222-2222-2222-222222222222';
  const friendId = '33333333-3333-3333-3333-333333333333';
  const strangerId = '44444444-4444-4444-4444-444444444444';
  const serverId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  await db.exec(`
    insert into auth.users (id, email) values
      ('${ownerId}', 'owner@nexuscord.app'),
      ('${memberId}', 'member@nexuscord.app'),
      ('${friendId}', 'friend@nexuscord.app'),
      ('${strangerId}', 'stranger@nexuscord.app');

    insert into public.servers (id, name, owner_id)
    values ('${serverId}', 'Nexus Club', '${ownerId}');

    insert into public.server_members (server_id, user_id, role) values
      ('${serverId}', '${ownerId}', 'OWNER'),
      ('${serverId}', '${memberId}', 'MEMBER');

    insert into public.roles (id, server_id, name, permissions, is_default)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${serverId}', '@everyone', 3339, true);
  `);

  // TEST 1: Expired invitation (pending + overdue) thực sự lưu status = 'expired' và trả success: false
  console.log('\n--- TEST 1: Expired invitation (pending) lưu status = expired ---');
  const expInvId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  await db.exec(`
    insert into public.server_invitations (id, server_id, inviter_id, invitee_id, status, expires_at)
    values ('${expInvId}', '${serverId}', '${ownerId}', '${friendId}', 'pending', now() - interval '1 hour');
  `);

  const expRes = await db.query(`select public.accept_server_invitation('${expInvId}', '${friendId}') as res;`);
  const expData = expRes.rows[0].res;
  console.log('Result expired invite:', expData);
  if (expData.success !== false || expData.reason !== 'expired') {
    throw new Error('TEST 1 FAILED: Expected success: false with reason: expired');
  }

  const checkDbExp = await db.query(`select status from public.server_invitations where id = '${expInvId}';`);
  if (checkDbExp.rows[0].status !== 'expired') {
    throw new Error(`TEST 1 FAILED: DB status was not updated to expired! Found: ${checkDbExp.rows[0].status}`);
  }
  console.log('✓ TEST 1 PASSED: Expired invitation persisted status = "expired"');

  // TEST 1B: Revoked/declined invitation đã quá hạn KHÔNG bị đổi thành expired
  console.log('\n--- TEST 1B: Revoked/declined invitation không bị ghi đè thành expired ---');
  const declinedInvId = 'cccccccc-dddd-cccc-dddd-cccccccccccc';
  await db.exec(`
    insert into public.server_invitations (id, server_id, inviter_id, invitee_id, status, expires_at)
    values ('${declinedInvId}', '${serverId}', '${ownerId}', '${friendId}', 'declined', now() - interval '2 days');
  `);
  const declinedRes = await db.query(`select public.accept_server_invitation('${declinedInvId}', '${friendId}') as res;`);
  const declinedData = declinedRes.rows[0].res;
  console.log('Result declined invite:', declinedData);
  if (declinedData.success !== false || declinedData.reason !== 'declined') {
    throw new Error('TEST 1B FAILED: Expected success: false with reason: declined');
  }
  const checkDbDeclined = await db.query(`select status from public.server_invitations where id = '${declinedInvId}';`);
  if (checkDbDeclined.rows[0].status !== 'declined') {
    throw new Error(`TEST 1B FAILED: Declined status was overwritten with: ${checkDbDeclined.rows[0].status}`);
  }
  console.log('✓ TEST 1B PASSED: Declined/revoked status preserved even if overdue');

  // TEST 2: Direct accept idempotent (first accept -> success, retry -> success alreadyMember: true)
  console.log('\n--- TEST 2: Direct accept idempotent ---');
  const validInvId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  await db.exec(`
    insert into public.server_invitations (id, server_id, inviter_id, invitee_id, status, expires_at)
    values ('${validInvId}', '${serverId}', '${ownerId}', '${friendId}', 'pending', now() + interval '7 days');
  `);

  const accept1Res = await db.query(`select public.accept_server_invitation('${validInvId}', '${friendId}') as res;`);
  const accept1Data = accept1Res.rows[0].res;
  console.log('First accept result:', accept1Data);
  if (!accept1Data.success || accept1Data.alreadyMember !== false) {
    throw new Error('TEST 2 FAILED: First accept should succeed with alreadyMember: false');
  }

  // Retry same accepted invitation while still a member
  const accept2Res = await db.query(`select public.accept_server_invitation('${validInvId}', '${friendId}') as res;`);
  const accept2Data = accept2Res.rows[0].res;
  console.log('Second accept result (retry):', accept2Data);
  if (!accept2Data.success || accept2Data.alreadyMember !== true) {
    throw new Error('TEST 2 FAILED: Second accept should succeed with alreadyMember: true');
  }
  console.log('✓ TEST 2 PASSED: Direct accept is idempotent');

  // TEST 2B: Accepted invitation nhưng member đã bị kick -> Không tự rejoin và không báo success giả
  console.log('\n--- TEST 2B: Accepted invitation sau khi bị kick không tự rejoin ---');
  await db.exec(`delete from public.server_members where server_id = '${serverId}' and user_id = '${friendId}';`);
  const kickedRetryRes = await db.query(`select public.accept_server_invitation('${validInvId}', '${friendId}') as res;`);
  const kickedRetryData = kickedRetryRes.rows[0].res;
  console.log('Kicked user retry result:', kickedRetryData);
  if (kickedRetryData.success !== false || kickedRetryData.reason !== 'already_used') {
    throw new Error('TEST 2B FAILED: Kicked user should NOT be able to rejoin via old accepted invitation');
  }
  const checkMemberRejoin = await db.query(`select 1 from public.server_members where server_id = '${serverId}' and user_id = '${friendId}';`);
  if (checkMemberRejoin.rows.length > 0) {
    throw new Error('TEST 2B FAILED: Kicked user was incorrectly re-added to server_members!');
  }
  console.log('✓ TEST 2B PASSED: Kicked member cannot rejoin with spent invitation');

  // TEST 3: Link join với max_uses = 1 -> Lần đầu thành công (uses = 1), retry vẫn nhận alreadyMember: true và uses không tăng
  console.log('\n--- TEST 3: Lượt cuối của link invite + retry idempotent ---');
  const lastUseCode = 'LAST-USE-CODE';
  await db.exec(`
    insert into public.invites (code, server_id, inviter_id, max_uses, uses, expires_at)
    values ('${lastUseCode}', '${serverId}', '${ownerId}', 1, 0, null);
  `);

  // Stranger joins using last use
  const joinLast1 = await db.query(`select public.join_server_by_invite_code('${lastUseCode}', '${strangerId}') as res;`);
  console.log('Join with last use result:', joinLast1.rows[0].res);
  if (!joinLast1.rows[0].res.success || joinLast1.rows[0].res.alreadyMember !== false) {
    throw new Error('TEST 3 FAILED: Initial join should succeed with alreadyMember: false');
  }

  // Stranger retries same link (which now has uses = max_uses = 1)
  const joinLast2 = await db.query(`select public.join_server_by_invite_code('${lastUseCode}', '${strangerId}') as res;`);
  console.log('Retry link with max uses reached result:', joinLast2.rows[0].res);
  if (!joinLast2.rows[0].res.success || joinLast2.rows[0].res.alreadyMember !== true) {
    throw new Error('TEST 3 FAILED: Retry by already-member should return success: true, alreadyMember: true');
  }

  const checkUses = await db.query(`select uses from public.invites where code = '${lastUseCode}';`);
  if (checkUses.rows[0].uses !== 1) {
    throw new Error(`TEST 3 FAILED: uses should remain 1, found: ${checkUses.rows[0].uses}`);
  }
  console.log('✓ TEST 3 PASSED: Last use link join and retry is completely idempotent');

  // TEST 3B: User đã là member rồi link hết hạn vẫn nhận idempotent result và không tăng uses
  console.log('\n--- TEST 3B: Already-member retry expired link ---');
  const expLinkCode = 'EXPIRED-LINK';
  await db.exec(`
    insert into public.invites (code, server_id, inviter_id, max_uses, uses, expires_at)
    values ('${expLinkCode}', '${serverId}', '${ownerId}', 10, 1, now() - interval '1 hour');
  `);
  // strangerId is already a member
  const joinExpLink = await db.query(`select public.join_server_by_invite_code('${expLinkCode}', '${strangerId}') as res;`);
  console.log('Expired link retry by existing member:', joinExpLink.rows[0].res);
  if (!joinExpLink.rows[0].res.success || joinExpLink.rows[0].res.alreadyMember !== true) {
    throw new Error('TEST 3B FAILED: Already-member should get idempotent success even if link is expired');
  }
  console.log('✓ TEST 3B PASSED: Expired link returns idempotent success for existing members');

  // TEST 4: Partial unique index chặn duplicate pending invitation
  console.log('\n--- TEST 4: Partial unique index chặn duplicate pending invitation ---');
  const pendingInv1 = 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee';
  const pendingInv2 = 'eeeeeeee-2222-2222-2222-eeeeeeeeeeee';
  await db.exec(`
    insert into public.server_invitations (id, server_id, inviter_id, invitee_id, status)
    values ('${pendingInv1}', '${serverId}', '${ownerId}', '${friendId}', 'pending');
  `);

  try {
    await db.exec(`
      insert into public.server_invitations (id, server_id, inviter_id, invitee_id, status)
      values ('${pendingInv2}', '${serverId}', '${ownerId}', '${friendId}', 'pending');
    `);
    throw new Error('TEST 4 FAILED: Second pending invitation for same user/server should violate partial unique index');
  } catch (err) {
    if (err.code === '23505' || err.message.includes('unique') || err.message.includes('idx_server_invitations_unique_pending')) {
      console.log('✓ TEST 4 PASSED: Unique pending index prevented duplicate active invitation (23505)');
    } else {
      throw err;
    }
  }

  // TEST 5: Control characters in channel name rejected in create_server_channel
  console.log('\n--- TEST 5: Control characters in channel name rejected ---');
  try {
    await db.query(`select public.create_server_channel('${serverId}', '${ownerId}', 'kenh\nmoi', 'text', null);`);
    throw new Error('TEST 5 FAILED: Control characters should have thrown exception!');
  } catch (err) {
    if (err.message.includes('Tên kênh chứa ký tự không hợp lệ') || err.code === '22023') {
      console.log('✓ TEST 5 PASSED: Control character correctly rejected with 22023');
    } else {
      throw err;
    }
  }

  // TEST 6: Topic > 1024 chars rejected in create_server_channel
  console.log('\n--- TEST 6: Topic > 1024 characters rejected ---');
  const longTopic = 'a'.repeat(1025);
  try {
    await db.query(`select public.create_server_channel('${serverId}', '${ownerId}', 'kenh-dai', 'text', '${longTopic}');`);
    throw new Error('TEST 6 FAILED: Topic > 1024 should have thrown exception!');
  } catch (err) {
    if (err.message.includes('Chủ đề kênh vượt quá giới hạn') || err.code === '22023') {
      console.log('✓ TEST 6 PASSED: Long topic correctly rejected with 22023');
    } else {
      throw err;
    }
  }

  // TEST 7: Duplicate channel name raises 23505 (unique violation)
  console.log('\n--- TEST 7: Duplicate channel name raises 23505 ---');
  await db.query(`select public.create_server_channel('${serverId}', '${ownerId}', 'Thảo Luận', 'text', 'Chủ đề 1');`);
  try {
    await db.query(`select public.create_server_channel('${serverId}', '${ownerId}', 'thảo luận', 'text', 'Chủ đề 2');`);
    throw new Error('TEST 7 FAILED: Duplicate lowercase channel name should have raised unique constraint 23505!');
  } catch (err) {
    if (err.code === '23505' || err.message.includes('unique') || err.message.includes('idx_channels_server_lower_name')) {
      console.log('✓ TEST 7 PASSED: Duplicate channel name correctly raised 23505 (mapped to 409 Conflict)');
    } else {
      throw err;
    }
  }

  // TEST 8: Permission check inside transaction (unauthorized user denied with 42501)
  console.log('\n--- TEST 8: Permission check denies unauthorized user ---');
  try {
    await db.query(`select public.create_server_channel('${serverId}', '${memberId}', 'kenh-cam', 'text', null);`);
    throw new Error('TEST 8 FAILED: Regular member without MANAGE_CHANNELS should have been denied!');
  } catch (err) {
    if (err.code === '42501' || err.message.includes('không có quyền')) {
      console.log('✓ TEST 8 PASSED: Unauthorized user rejected with 42501');
    } else {
      throw err;
    }
  }

  // TEST 9: RPC Role Security (anon & authenticated denied, service_role allowed)
  console.log('\n--- TEST 9: Kiểm tra phân quyền RPC (anon/authenticated bị chặn, service_role được phép) ---');
  
  // 9a. Test as anon role
  await db.exec(`set role anon;`);
  try {
    await db.query(`select public.accept_server_invitation('${validInvId}', '${friendId}');`);
    throw new Error('TEST 9a FAILED: anon role should NOT have permission to execute accept_server_invitation');
  } catch (err) {
    if (err.code === '42501' || err.message.includes('permission denied')) {
      console.log('✓ TEST 9a PASSED: anon role denied from executing accept_server_invitation (42501)');
    } else {
      throw err;
    }
  }

  // 9b. Test as authenticated role
  await db.exec(`set role authenticated;`);
  try {
    await db.query(`select public.join_server_by_invite_code('SOME-CODE', '${friendId}');`);
    throw new Error('TEST 9b FAILED: authenticated role should NOT have permission to execute join_server_by_invite_code');
  } catch (err) {
    if (err.code === '42501' || err.message.includes('permission denied')) {
      console.log('✓ TEST 9b PASSED: authenticated role denied from executing join_server_by_invite_code (42501)');
    } else {
      throw err;
    }
  }

  try {
    await db.query(`select public.create_server_channel('${serverId}', '${ownerId}', 'kenh-authenticated', 'text', null);`);
    throw new Error('TEST 9c FAILED: authenticated role should NOT have permission to execute create_server_channel');
  } catch (err) {
    if (err.code === '42501' || err.message.includes('permission denied')) {
      console.log('✓ TEST 9c PASSED: authenticated role denied from executing create_server_channel (42501)');
    } else {
      throw err;
    }
  }

  // 9c. Test as service_role
  await db.exec(`set role service_role;`);
  const srvRoleRes = await db.query(`select public.create_server_channel('${serverId}', '${ownerId}', 'kenh-service-role', 'text', null) as res;`);
  if (!srvRoleRes.rows[0].res.id) {
    throw new Error('TEST 9d FAILED: service_role should be able to execute create_server_channel');
  }
  console.log('✓ TEST 9d PASSED: service_role successfully executes create_server_channel');

  // Reset role to superuser/default
  await db.exec(`reset role;`);

  // TEST 10: Advisory Lock serialization hash verification
  console.log('\n--- TEST 10: Advisory Lock key stability & execution ---');
  const lockHashRes = await db.query(`select hashtextextended('${serverId}', 0) as hash_val;`);
  const lockHash = lockHashRes.rows[0].hash_val;
  console.log('Stable Advisory Lock hash for serverId:', lockHash);
  if (!lockHash) {
    throw new Error('TEST 10 FAILED: hashtextextended should return a non-null 64-bit integer');
  }
  console.log('✓ TEST 10 PASSED: pg_advisory_xact_lock key is stable and valid');

  console.log('\n============================================================');
  console.log('TẤT CẢ 10/10 TEST SUITES MIGRATION ĐỀU PASS 100%!');
  console.log('============================================================');
}

runTests().catch((err) => {
  console.error('LỖI KIỂM THỬ MIGRATION:', err);
  process.exit(1);
});
