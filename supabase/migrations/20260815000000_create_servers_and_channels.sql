-- ============================================================================
-- Migration: Tạo bảng servers, server_members, channels và hàm khởi tạo server
--
-- Mỗi server thuộc về một owner_id (references auth.users).
-- Khi tạo server, tự động tạo membership OWNER và kênh mặc định 'chung'.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bảng public.servers
-- ---------------------------------------------------------------------------
create table if not exists public.servers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  icon_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint servers_name_length check (
    char_length(trim(name)) between 2 and 100
  )
);

comment on table public.servers is 'Danh sách các máy chủ (server/guild) trong NexusCord.';

-- Trigger touch_updated_at cho servers
drop trigger if exists servers_touch_updated_at on public.servers;
create trigger servers_touch_updated_at
  before update on public.servers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Bảng public.server_members
-- ---------------------------------------------------------------------------
create table if not exists public.server_members (
  server_id uuid not null references public.servers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'OWNER',
  joined_at timestamptz not null default now(),

  primary key (server_id, user_id),
  constraint server_members_role_check check (
    role in ('OWNER', 'ADMIN', 'MEMBER')
  )
);

comment on table public.server_members is 'Thành viên và vai trò trong từng máy chủ.';

-- Index hỗ trợ query danh sách server theo user
create index if not exists idx_server_members_user_id on public.server_members (user_id);

-- ---------------------------------------------------------------------------
-- 3. Bảng public.channels
-- ---------------------------------------------------------------------------
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers (id) on delete cascade,
  name text not null,
  type text not null default 'text',
  topic text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint channels_name_length check (
    char_length(trim(name)) between 1 and 100
  ),
  constraint channels_type_check check (
    type in ('text', 'voice')
  )
);

comment on table public.channels is 'Các kênh giao tiếp thuộc về một máy chủ.';

create index if not exists idx_channels_server_id on public.channels (server_id);

-- Trigger touch_updated_at cho channels
drop trigger if exists channels_touch_updated_at on public.channels;
create trigger channels_touch_updated_at
  before update on public.channels
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security (RLS)
-- ---------------------------------------------------------------------------
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.channels enable row level security;

-- Policy SELECT: User chỉ đọc được server mà mình là thành viên
drop policy if exists "Thành viên đọc được thông tin server" on public.servers;
create policy "Thành viên đọc được thông tin server"
  on public.servers for select
  to authenticated
  using (
    exists (
      select 1 from public.server_members sm
      where sm.server_id = servers.id
        and sm.user_id = (select auth.uid())
    )
  );

-- Policy SELECT: User chỉ đọc được thành viên của server mà mình tham gia
drop policy if exists "Thành viên đọc được danh sách thành viên cùng server" on public.server_members;
create policy "Thành viên đọc được danh sách thành viên cùng server"
  on public.server_members for select
  to authenticated
  using (
    exists (
      select 1 from public.server_members sm
      where sm.server_id = server_members.server_id
        and sm.user_id = (select auth.uid())
    )
  );

-- Policy SELECT: User chỉ đọc được kênh của server mà mình tham gia
drop policy if exists "Thành viên đọc được kênh của server" on public.channels;
create policy "Thành viên đọc được kênh của server"
  on public.channels for select
  to authenticated
  using (
    exists (
      select 1 from public.server_members sm
      where sm.server_id = channels.server_id
        and sm.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Atomic Transaction Function: create_server_with_defaults
-- ---------------------------------------------------------------------------
create or replace function public.create_server_with_defaults(
  p_owner_id uuid,
  p_name text,
  p_icon_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_server_id uuid;
  v_channel_id uuid;
  v_trimmed_name text;
  v_result jsonb;
begin
  v_trimmed_name := trim(p_name);
  if char_length(v_trimmed_name) < 2 or char_length(v_trimmed_name) > 100 then
    raise exception 'Tên máy chủ phải từ 2 đến 100 ký tự' using errcode = '22023';
  end if;

  -- 1. Tạo server
  insert into public.servers (owner_id, name, icon_url)
  values (p_owner_id, v_trimmed_name, p_icon_url)
  returning id into v_server_id;

  -- 2. Thêm owner vào server_members
  insert into public.server_members (server_id, user_id, role)
  values (v_server_id, p_owner_id, 'OWNER');

  -- 3. Tạo kênh chữ mặc định 'chung'
  insert into public.channels (server_id, name, type, position)
  values (v_server_id, 'chung', 'text', 0)
  returning id into v_channel_id;

  -- 4. Gom kết quả trả về
  v_result := jsonb_build_object(
    'server', jsonb_build_object(
      'id', v_server_id,
      'name', v_trimmed_name,
      'iconUrl', p_icon_url,
      'unread', false,
      'mentionCount', 0
    ),
    'defaultChannel', jsonb_build_object(
      'id', v_channel_id,
      'name', 'chung',
      'type', 'text',
      'topic', null,
      'unread', false,
      'mentionCount', 0
    )
  );

  return v_result;
end;
$$;

-- Thu hồi quyền execute từ public/anon/authenticated, chỉ cấp cho service_role
revoke execute on function public.create_server_with_defaults(uuid, text, text) from public;
revoke execute on function public.create_server_with_defaults(uuid, text, text) from anon;
revoke execute on function public.create_server_with_defaults(uuid, text, text) from authenticated;
grant execute on function public.create_server_with_defaults(uuid, text, text) to service_role;
