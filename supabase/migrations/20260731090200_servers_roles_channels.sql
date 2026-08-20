-- ============================================================================
-- Server, thành viên, role/permission, channel
--
-- Nguồn: docs/nexus_schema.sql mục 3, 4, 5, 14.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SERVERS & MEMBERSHIP
-- ---------------------------------------------------------------------------
create table if not exists public.servers (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    icon_url    text,
    banner_url  text,
    owner_id    uuid not null references public.profiles(id) on delete restrict,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint server_name_len check (char_length(name) between 2 and 100)
);

create index if not exists idx_servers_owner on public.servers (owner_id);

create table if not exists public.server_members (
    server_id   uuid not null references public.servers(id) on delete cascade,
    user_id     uuid not null references public.profiles(id) on delete cascade,
    nickname    text,
    joined_at   timestamptz not null default now(),

    primary key (server_id, user_id),
    constraint nickname_len check (nickname is null or char_length(nickname) between 1 and 32)
);

-- "User này ở trong những server nào" — chạy mỗi lần load Dashboard.
create index if not exists idx_server_members_user on public.server_members (user_id);

-- ---------------------------------------------------------------------------
-- ROLES & PERMISSIONS (bitfield kiểu Discord)
--
-- `permissions` là bitmask bigint. Hằng số định nghĩa ở shared/permissions.ts —
-- đó mới là nguồn chân lý, đừng chép số vào đây.
--
-- Thuật toán tính quyền hiệu lực (PermissionsGuard):
--   base = OR permissions của mọi role user đang có
--   nếu base có ADMINISTRATOR -> allow tất cả
--   áp overwrite theo đúng thứ tự: @everyone -> các role -> member cụ thể
--   mỗi bước: perms = (perms & ~deny) | allow
-- Sai thứ tự = user tự nâng quyền được.
-- ---------------------------------------------------------------------------
create table if not exists public.roles (
    id           uuid primary key default gen_random_uuid(),
    server_id    uuid not null references public.servers(id) on delete cascade,
    name         text not null,
    color        integer not null default 0,          -- RGB dạng int, 0 = mặc định
    permissions  bigint  not null default 0,
    position     integer not null default 0,          -- càng cao càng nhiều quyền lực
    is_default   boolean not null default false,      -- role @everyone
    created_at   timestamptz not null default now(),

    constraint role_name_len check (char_length(name) between 1 and 32)
);

create index if not exists idx_roles_server on public.roles (server_id, position desc);

-- Mỗi server chỉ có đúng một role @everyone.
create unique index if not exists idx_roles_one_default
    on public.roles (server_id) where is_default;

create table if not exists public.member_roles (
    role_id     uuid not null references public.roles(id) on delete cascade,
    user_id     uuid not null references public.profiles(id) on delete cascade,
    server_id   uuid not null references public.servers(id) on delete cascade,
    assigned_at timestamptz not null default now(),

    primary key (role_id, user_id),
    -- Chặn gán role cho người chưa phải thành viên server.
    foreign key (server_id, user_id)
        references public.server_members(server_id, user_id) on delete cascade
);

create index if not exists idx_member_roles_lookup on public.member_roles (server_id, user_id);

-- ---------------------------------------------------------------------------
-- CHANNELS
-- ---------------------------------------------------------------------------
create table if not exists public.channels (
    id          uuid primary key default gen_random_uuid(),
    server_id   uuid not null references public.servers(id) on delete cascade,
    name        text not null,
    type        channel_type not null default 'text',
    topic       text,
    position    integer not null default 0,
    is_private  boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint channel_name_len check (char_length(name) between 1 and 100),
    constraint topic_len        check (topic is null or char_length(topic) <= 1024)
);

create index if not exists idx_channels_server on public.channels (server_id, position);

-- Trùng tên kênh trong cùng server thì rối UI -> chặn luôn.
create unique index if not exists idx_channels_unique_name
    on public.channels (server_id, lower(name));

-- Permission overwrite cấp channel. Phần UI thuộc trang Setting và có thể hoãn
-- (§7 mục cắt số 3) — schema vẫn dựng sẵn để không phải migrate lại.
create table if not exists public.channel_overwrites (
    channel_id   uuid not null references public.channels(id) on delete cascade,
    target_type  overwrite_target not null,
    target_id    uuid not null,                       -- role_id hoặc user_id
    allow        bigint not null default 0,
    deny         bigint not null default 0,

    primary key (channel_id, target_type, target_id)
);

-- ---------------------------------------------------------------------------
-- SEED — role @everyone khi tạo server
--
-- NestJS gọi hàm này trong ServerService.create(), cùng transaction với insert
-- server + insert owner vào server_members.
--
-- Quyền mặc định = VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | CREATE_INVITE
--                  | CONNECT_VOICE | SPEAK_VOICE
--                = 1 + 2 + 8 + 256 + 1024 + 2048 = 3339
-- Con số này phải khớp DEFAULT_EVERYONE_PERMISSIONS trong shared/permissions.ts.
-- ---------------------------------------------------------------------------
create or replace function public.create_default_role(p_server_id uuid)
returns uuid
language plpgsql
as $$
declare
    v_role_id uuid;
begin
    insert into public.roles (server_id, name, permissions, position, is_default)
    values (p_server_id, '@everyone', 3339, 0, true)
    returning id into v_role_id;

    return v_role_id;
end;
$$;
