-- ============================================================================
-- Migration: 20260825160000_direct_friend_calls.sql
-- Checkpoint 12.5: Direct Friend Audio/Video Calls in DM (Canonical State & Concurrency)
-- ============================================================================

-- 1. Bảng lưu trữ phiên cuộc gọi canonical
create table if not exists public.direct_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  caller_session_id uuid not null,
  answered_session_id uuid,
  initial_mode text not null check (initial_mode in ('audio', 'video')),
  status text not null check (
    status in ('ringing', 'accepted', 'declined', 'cancelled', 'missed', 'ended', 'failed')
  ) default 'ringing',
  livekit_room_name text not null unique,
  initiated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  answered_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  ended_by uuid references public.profiles(id) on delete set null,
  end_reason text check (
    end_reason in (
      'hangup', 'no_answer', 'declined', 'caller_cancelled',
      'busy', 'permission_denied', 'media_failed',
      'network_timeout', 'blocked_or_unfriended', 'failed'
    )
  ),
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint direct_calls_caller_diff_callee check (caller_id <> callee_id)
);

-- 2. Bảng Claim Người Dùng Đang Bận Gọi (Active User Claim Table)
-- Đảm bảo mỗi user_id chỉ tham gia đúng 1 cuộc gọi active tại một thời điểm (Database Invariant tuyệt đối)
create table if not exists public.direct_call_active_users (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  call_id uuid not null references public.direct_calls(id) on delete cascade,
  claimed_at timestamptz not null default clock_timestamp()
);

-- 3. Bảng Outbox Dọn Dẹp LiveKit Room (Transactional Outbox Pattern)
create table if not exists public.direct_call_room_cleanup_outbox (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null,
  room_name text not null,
  status text not null check (status in ('pending', 'processing', 'completed', 'failed')) default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

-- Chỉ mục tối ưu truy vấn
create index if not exists idx_direct_calls_conversation
  on public.direct_calls (conversation_id, created_at desc);

create index if not exists idx_direct_calls_expiring
  on public.direct_calls (expires_at)
  where (status = 'ringing');

create index if not exists idx_direct_call_active_users_call
  on public.direct_call_active_users (call_id);

create index if not exists idx_cleanup_outbox_pending
  on public.direct_call_room_cleanup_outbox (next_attempt_at, attempts)
  where (status in ('pending', 'processing'));

-- Bật RLS
alter table public.direct_calls enable row level security;
alter table public.direct_call_active_users enable row level security;
alter table public.direct_call_room_cleanup_outbox enable row level security;

-- Phân quyền: Revoke public/anon/authenticated, chỉ service_role được thao tác
revoke all on table public.direct_calls from public, anon, authenticated;
revoke all on table public.direct_call_active_users from public, anon, authenticated;
revoke all on table public.direct_call_room_cleanup_outbox from public, anon, authenticated;

grant all on table public.direct_calls to service_role;
grant all on table public.direct_call_active_users to service_role;
grant all on table public.direct_call_room_cleanup_outbox to service_role;

-- Policies: Cho phép service_role toàn quyền truy cập
drop policy if exists "service_role_direct_calls" on public.direct_calls;
create policy "service_role_direct_calls" on public.direct_calls for all to service_role using (true) with check (true);

drop policy if exists "service_role_direct_call_active_users" on public.direct_call_active_users;
create policy "service_role_direct_call_active_users" on public.direct_call_active_users for all to service_role using (true) with check (true);

drop policy if exists "service_role_direct_call_room_cleanup_outbox" on public.direct_call_room_cleanup_outbox;
create policy "service_role_direct_call_room_cleanup_outbox" on public.direct_call_room_cleanup_outbox for all to service_role using (true) with check (true);

-- ============================================================================
-- RPC Functions (Atomic Stored Procedures)
-- ============================================================================

-- 1. start_direct_call
create or replace function public.start_direct_call(
  p_conversation_id uuid,
  p_caller_id uuid,
  p_caller_session_id uuid,
  p_initial_mode text,
  p_ring_timeout_seconds integer default 45
)
returns setof public.direct_calls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_conv record;
  v_callee_id uuid;
  v_friendship record;
  v_call public.direct_calls;
  v_call_id uuid;
  v_room_name text;
  v_expires_at timestamptz;
  v_u1 uuid;
  v_u2 uuid;
begin
  -- A. Kiểm tra conversation hợp lệ
  select id, type into v_conv
  from public.conversations
  where id = p_conversation_id;

  if not found or v_conv.type <> 'dm' then
    raise exception 'Cuộc trò chuyện không tồn tại hoặc không phải là Direct Message 1-1.'
      using errcode = '22023';
  end if;

  -- B. Tìm Callee từ conversation_participants
  select user_id into v_callee_id
  from public.conversation_participants
  where conversation_id = p_conversation_id
    and user_id <> p_caller_id
  limit 1;

  if v_callee_id is null then
    raise exception 'Không tìm thấy người nhận trong cuộc trò chuyện.'
      using errcode = '22023';
  end if;

  -- C. Xác định thứ tự khóa advisory xact lock để chống deadlock (A gọi B vs B gọi A)
  if p_caller_id < v_callee_id then
    v_u1 := p_caller_id;
    v_u2 := v_callee_id;
  else
    v_u1 := v_callee_id;
    v_u2 := p_caller_id;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_u1::text));
  perform pg_advisory_xact_lock(hashtext(v_u2::text));

  -- D. Kiểm tra quan hệ bạn bè hợp lệ (friendships.status = 'accepted')
  select status into v_friendship
  from public.friendships
  where (user_a_id = v_u1 and user_b_id = v_u2);

  if not found or v_friendship.status <> 'accepted' then
    if found and v_friendship.status = 'blocked' then
      raise exception 'Không thể thực hiện cuộc gọi do có quan hệ chặn.'
        using errcode = '42501';
    end if;
    raise exception 'Chỉ có thể gọi điện với người dùng đã kết bạn.'
      using errcode = '42501';
  end if;

  -- E. Kiểm tra bận (Active User Claim)
  if exists (
    select 1 from public.direct_call_active_users
    where user_id in (p_caller_id, v_callee_id)
  ) then
    raise exception 'BUSY: Người dùng hiện đang trong một cuộc gọi khác.'
      using errcode = '23505'; -- Unique violation / busy signal
  end if;

  -- G. Tạo mới Call Record
  v_call_id := gen_random_uuid();
  v_room_name := 'nexus:dm-call:' || v_call_id::text;
  v_expires_at := clock_timestamp() + (coalesce(p_ring_timeout_seconds, 45) || ' seconds')::interval;

  insert into public.direct_calls (
    id,
    conversation_id,
    caller_id,
    callee_id,
    caller_session_id,
    initial_mode,
    status,
    livekit_room_name,
    initiated_at,
    expires_at,
    version
  ) values (
    v_call_id,
    p_conversation_id,
    p_caller_id,
    v_callee_id,
    p_caller_session_id,
    p_initial_mode,
    'ringing',
    v_room_name,
    clock_timestamp(),
    v_expires_at,
    1
  ) returning * into v_call;

  -- H. Chèn cả 2 user vào bảng claim
  insert into public.direct_call_active_users (user_id, call_id)
  values (p_caller_id, v_call_id), (v_callee_id, v_call_id);

  return next v_call;
  return;
end;
$$;

-- 2. answer_direct_call
create or replace function public.answer_direct_call(
  p_call_id uuid,
  p_user_id uuid,
  p_client_session_id uuid
)
returns table (
  id uuid,
  conversation_id uuid,
  caller_id uuid,
  callee_id uuid,
  caller_session_id uuid,
  answered_session_id uuid,
  initial_mode text,
  status text,
  livekit_room_name text,
  initiated_at timestamptz,
  expires_at timestamptz,
  answered_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  ended_by uuid,
  end_reason text,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  should_join_media boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_call public.direct_calls;
begin
  select * into v_call
  from public.direct_calls
  where public.direct_calls.id = p_call_id
  for update;

  if not found then
    raise exception 'Cuộc gọi không tồn tại.'
      using errcode = 'P0002';
  end if;

  if v_call.callee_id <> p_user_id then
    raise exception 'Chỉ người nhận mới có quyền chấp nhận cuộc gọi.'
      using errcode = '42501';
  end if;

  -- Kiểm tra quá hạn
  if v_call.status = 'ringing' and clock_timestamp() > v_call.expires_at then
    update public.direct_calls
    set status = 'missed',
        ended_at = clock_timestamp(),
        end_reason = 'no_answer',
        version = public.direct_calls.version + 1,
        updated_at = clock_timestamp()
    where public.direct_calls.id = p_call_id
    returning * into v_call;

    delete from public.direct_call_active_users where call_id = p_call_id;

    insert into public.direct_call_room_cleanup_outbox (call_id, room_name)
    values (v_call.id, v_call.livekit_room_name);

    raise exception 'EXPIRED: Cuộc gọi đã kết thúc do hết thời gian chờ.'
      using errcode = '22023';
  end if;

  -- Idempotent nếu đã accepted
  if v_call.status = 'accepted' then
    return query select
      v_call.id,
      v_call.conversation_id,
      v_call.caller_id,
      v_call.callee_id,
      v_call.caller_session_id,
      v_call.answered_session_id,
      v_call.initial_mode,
      v_call.status,
      v_call.livekit_room_name,
      v_call.initiated_at,
      v_call.expires_at,
      v_call.answered_at,
      v_call.connected_at,
      v_call.ended_at,
      v_call.ended_by,
      v_call.end_reason,
      v_call.version,
      v_call.created_at,
      v_call.updated_at,
      (v_call.answered_session_id = p_client_session_id);
    return;
  end if;

  if v_call.status <> 'ringing' then
    raise exception 'Cuộc gọi không còn ở trạng thái đổ chuông (trạng thái hiện tại: %)', v_call.status
      using errcode = '22023';
  end if;

  -- Chấp nhận cuộc gọi
  update public.direct_calls
  set status = 'accepted',
      answered_at = clock_timestamp(),
      answered_session_id = p_client_session_id,
      version = public.direct_calls.version + 1,
      updated_at = clock_timestamp()
  where public.direct_calls.id = p_call_id
  returning * into v_call;

  return query select
    v_call.id,
    v_call.conversation_id,
    v_call.caller_id,
    v_call.callee_id,
    v_call.caller_session_id,
    v_call.answered_session_id,
    v_call.initial_mode,
    v_call.status,
    v_call.livekit_room_name,
    v_call.initiated_at,
    v_call.expires_at,
    v_call.answered_at,
    v_call.connected_at,
    v_call.ended_at,
    v_call.ended_by,
    v_call.end_reason,
    v_call.version,
    v_call.created_at,
    v_call.updated_at,
    true;
end;
$$;

-- 3. decline_direct_call
create or replace function public.decline_direct_call(
  p_call_id uuid,
  p_user_id uuid
)
returns setof public.direct_calls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_call public.direct_calls;
begin
  select * into v_call
  from public.direct_calls
  where id = p_call_id
  for update;

  if not found then
    raise exception 'Cuộc gọi không tồn tại.'
      using errcode = 'P0002';
  end if;

  if v_call.callee_id <> p_user_id then
    raise exception 'Chỉ người nhận mới có quyền từ chối cuộc gọi.'
      using errcode = '42501';
  end if;

  if v_call.status in ('declined', 'cancelled', 'missed', 'ended', 'failed') then
    return next v_call; -- Idempotent
    return;
  end if;

  update public.direct_calls
  set status = 'declined',
      ended_at = clock_timestamp(),
      ended_by = p_user_id,
      end_reason = 'declined',
      version = public.direct_calls.version + 1,
      updated_at = clock_timestamp()
  where id = p_call_id
  returning * into v_call;

  delete from public.direct_call_active_users where call_id = p_call_id;

  insert into public.direct_call_room_cleanup_outbox (call_id, room_name)
  values (v_call.id, v_call.livekit_room_name);

  return next v_call;
  return;
end;
$$;

-- 4. cancel_direct_call
create or replace function public.cancel_direct_call(
  p_call_id uuid,
  p_user_id uuid
)
returns setof public.direct_calls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_call public.direct_calls;
begin
  select * into v_call
  from public.direct_calls
  where id = p_call_id
  for update;

  if not found then
    raise exception 'Cuộc gọi không tồn tại.'
      using errcode = 'P0002';
  end if;

  if v_call.caller_id <> p_user_id then
    raise exception 'Chỉ người gọi mới có quyền hủy cuộc gọi đang đổ chuông.'
      using errcode = '42501';
  end if;

  if v_call.status in ('cancelled', 'declined', 'missed', 'ended', 'failed') then
    return next v_call; -- Idempotent
    return;
  end if;

  update public.direct_calls
  set status = 'cancelled',
      ended_at = clock_timestamp(),
      ended_by = p_user_id,
      end_reason = 'caller_cancelled',
      version = public.direct_calls.version + 1,
      updated_at = clock_timestamp()
  where id = p_call_id
  returning * into v_call;

  delete from public.direct_call_active_users where call_id = p_call_id;

  insert into public.direct_call_room_cleanup_outbox (call_id, room_name)
  values (v_call.id, v_call.livekit_room_name);

  return next v_call;
  return;
end;
$$;

-- 5. mark_direct_call_connected
create or replace function public.mark_direct_call_connected(
  p_call_id uuid
)
returns table (
  id uuid,
  conversation_id uuid,
  caller_id uuid,
  callee_id uuid,
  caller_session_id uuid,
  answered_session_id uuid,
  initial_mode text,
  status text,
  livekit_room_name text,
  initiated_at timestamptz,
  expires_at timestamptz,
  answered_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  ended_by uuid,
  end_reason text,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  did_transition boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_call public.direct_calls;
  v_did_transition boolean := false;
begin
  select * into v_call
  from public.direct_calls
  where direct_calls.id = p_call_id
  for update;

  if not found then
    raise exception 'Cuộc gọi không tồn tại.'
      using errcode = 'P0002';
  end if;

  if v_call.status <> 'accepted' then
    return query select
      v_call.id, v_call.conversation_id, v_call.caller_id, v_call.callee_id,
      v_call.caller_session_id, v_call.answered_session_id, v_call.initial_mode,
      v_call.status, v_call.livekit_room_name, v_call.initiated_at, v_call.expires_at,
      v_call.answered_at, v_call.connected_at, v_call.ended_at, v_call.ended_by,
      v_call.end_reason, v_call.version, v_call.created_at, v_call.updated_at,
      false as did_transition;
    return;
  end if;

  -- Nếu chưa ghi nhận connected_at thì cập nhật
  if v_call.connected_at is null then
    update public.direct_calls
    set connected_at = clock_timestamp(),
        version = public.direct_calls.version + 1,
        updated_at = clock_timestamp()
    where direct_calls.id = p_call_id
    returning * into v_call;
    v_did_transition := true;
  end if;

  return query select
    v_call.id, v_call.conversation_id, v_call.caller_id, v_call.callee_id,
    v_call.caller_session_id, v_call.answered_session_id, v_call.initial_mode,
    v_call.status, v_call.livekit_room_name, v_call.initiated_at, v_call.expires_at,
    v_call.answered_at, v_call.connected_at, v_call.ended_at, v_call.ended_by,
    v_call.end_reason, v_call.version, v_call.created_at, v_call.updated_at,
    v_did_transition;
  return;
end;
$$;

-- 6. end_direct_call
create or replace function public.end_direct_call(
  p_call_id uuid,
  p_user_id uuid,
  p_end_reason text default 'hangup'
)
returns setof public.direct_calls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_call public.direct_calls;
begin
  select * into v_call
  from public.direct_calls
  where id = p_call_id
  for update;

  if not found then
    raise exception 'Cuộc gọi không tồn tại.'
      using errcode = 'P0002';
  end if;

  if v_call.caller_id <> p_user_id and v_call.callee_id <> p_user_id then
    raise exception 'Bạn không phải là thành viên của cuộc gọi này.'
      using errcode = '42501';
  end if;

  if v_call.status in ('ended', 'cancelled', 'declined', 'missed', 'failed') then
    return next v_call; -- Idempotent
    return;
  end if;

  update public.direct_calls
  set status = 'ended',
      ended_at = clock_timestamp(),
      ended_by = p_user_id,
      end_reason = coalesce(p_end_reason, 'hangup'),
      version = public.direct_calls.version + 1,
      updated_at = clock_timestamp()
  where id = p_call_id
  returning * into v_call;

  delete from public.direct_call_active_users where call_id = p_call_id;

  insert into public.direct_call_room_cleanup_outbox (call_id, room_name)
  values (v_call.id, v_call.livekit_room_name);

  return next v_call;
  return;
end;
$$;

-- 7. expire_ringing_direct_calls (Multi-instance safe)
create or replace function public.expire_ringing_direct_calls()
returns setof public.direct_calls
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with expired_calls as (
    select id, conversation_id, caller_id, callee_id, livekit_room_name
    from public.direct_calls
    where status = 'ringing' and expires_at < clock_timestamp()
    order by expires_at
    limit 50
    for update skip locked
  ),
  updated_calls as (
    update public.direct_calls c
    set status = 'missed',
        ended_at = clock_timestamp(),
        end_reason = 'no_answer',
        version = c.version + 1,
        updated_at = clock_timestamp()
    from expired_calls e
    where c.id = e.id
    returning c.*
  ),
  deleted_claims as (
    delete from public.direct_call_active_users
    where call_id in (select id from updated_calls)
  ),
  enqueued_cleanup as (
    insert into public.direct_call_room_cleanup_outbox (call_id, room_name)
    select id, livekit_room_name from updated_calls
  )
  select * from updated_calls;
end;
$$;

-- Revoke execute from public/anon/authenticated, grant to service_role
revoke execute on function public.start_direct_call(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.answer_direct_call(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.decline_direct_call(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cancel_direct_call(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.mark_direct_call_connected(uuid) from public, anon, authenticated;
revoke execute on function public.end_direct_call(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.expire_ringing_direct_calls() from public, anon, authenticated;

grant execute on function public.start_direct_call(uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.answer_direct_call(uuid, uuid, uuid) to service_role;
grant execute on function public.decline_direct_call(uuid, uuid) to service_role;
grant execute on function public.cancel_direct_call(uuid, uuid) to service_role;
grant execute on function public.mark_direct_call_connected(uuid) to service_role;
grant execute on function public.end_direct_call(uuid, uuid, text) to service_role;
grant execute on function public.expire_ringing_direct_calls() to service_role;
