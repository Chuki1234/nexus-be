-- ============================================================================
-- Bạn bè, lời mời, cài đặt, thông báo
--
-- Nguồn: docs/nexus_schema.sql mục 10, 11.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- FRIENDSHIPS
--
-- Một dòng cho mỗi cặp, ràng buộc user_a_id < user_b_id để không bao giờ có hai
-- dòng đối xứng. requested_by cho biết ai gửi lời mời.
-- ---------------------------------------------------------------------------
create table if not exists public.friendships (
    user_a_id     uuid not null references public.profiles(id) on delete cascade,
    user_b_id     uuid not null references public.profiles(id) on delete cascade,
    requested_by  uuid not null references public.profiles(id) on delete cascade,
    status        friendship_status not null default 'pending',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),

    primary key (user_a_id, user_b_id),
    constraint friendship_ordered check (user_a_id < user_b_id)
);

create index if not exists idx_friendships_b on public.friendships (user_b_id);

-- ---------------------------------------------------------------------------
-- INVITES
-- ---------------------------------------------------------------------------
create table if not exists public.invites (
    code        text primary key,                     -- nanoid 8-10 ký tự
    server_id   uuid not null references public.servers(id) on delete cascade,
    channel_id  uuid references public.channels(id) on delete set null,
    inviter_id  uuid not null references public.profiles(id) on delete cascade,
    max_uses    integer,                              -- null = không giới hạn
    uses        integer not null default 0,
    expires_at  timestamptz,                          -- null = vĩnh viễn
    created_at  timestamptz not null default now(),

    constraint uses_valid check (max_uses is null or uses <= max_uses)
);

create index if not exists idx_invites_server on public.invites (server_id);

-- ---------------------------------------------------------------------------
-- USER SETTINGS
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
    user_id                 uuid primary key references public.profiles(id) on delete cascade,
    locale                  text not null default 'vi',   -- ngx-translate
    theme                   text not null default 'dark',
    notification_prefs      jsonb not null default '{}'::jsonb,
    updated_at              timestamptz not null default now(),

    constraint locale_supported check (locale in ('vi', 'en'))
);

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS — chỉ in-app, không push ra ngoài trình duyệt (§3.8)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(id) on delete cascade,
    type        text not null,                        -- 'friend_request' | 'mention' | ...
    payload     jsonb not null default '{}'::jsonb,
    read_at     timestamptz,
    created_at  timestamptz not null default now()
);

-- Truy vấn nóng: thông báo chưa đọc của một user.
create index if not exists idx_notifications_unread
    on public.notifications (user_id, created_at desc) where read_at is null;
