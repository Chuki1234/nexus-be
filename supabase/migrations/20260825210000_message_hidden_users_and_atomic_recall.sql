-- ============================================================================
-- Migration: Message Hidden Users, Storage Cleanup Outbox & Atomic Message Recall RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table: message_hidden_users (Lưu các tin nhắn người dùng chọn "Xóa ở phía bạn")
-- ----------------------------------------------------------------------------
create table if not exists public.message_hidden_users (
    user_id    uuid not null references public.profiles(id) on delete cascade,
    message_id bigint not null references public.messages(id) on delete cascade,
    created_at timestamptz not null default timezone('utc'::text, now()),
    primary key (user_id, message_id)
);

create index if not exists idx_message_hidden_users_message 
    on public.message_hidden_users(message_id);

alter table public.message_hidden_users enable row level security;
revoke all on public.message_hidden_users from public, anon, authenticated;
grant all on public.message_hidden_users to service_role;

-- ----------------------------------------------------------------------------
-- 2. Table: storage_cleanup_outbox (Bảo đảm bảng Outbox tồn tại)
-- ----------------------------------------------------------------------------
create table if not exists public.storage_cleanup_outbox (
    id               uuid primary key default gen_random_uuid(),
    bucket           text not null default 'message-attachments',
    storage_path     text not null,
    target_type      text not null,
    target_id        text not null,
    status           text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
    attempts         int not null default 0,
    next_attempt_at  timestamptz not null default now(),
    locked_at        timestamptz,
    locked_by        text,
    lease_expires_at timestamptz,
    last_error       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint uq_storage_cleanup_bucket_path unique (bucket, storage_path)
);

create index if not exists idx_storage_cleanup_outbox_queue
    on public.storage_cleanup_outbox (status, next_attempt_at)
    where status in ('pending', 'processing', 'failed');

alter table public.storage_cleanup_outbox enable row level security;
revoke all on public.storage_cleanup_outbox from public, anon, authenticated;
grant all on public.storage_cleanup_outbox to service_role;

-- ----------------------------------------------------------------------------
-- 3. RPC: hide_message_for_user (Ẩn tin nhắn chỉ riêng tài khoản của người dùng)
-- ----------------------------------------------------------------------------
create or replace function public.hide_message_for_user(
    p_user_id    uuid,
    p_message_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_msg record;
    v_is_member boolean := false;
    v_chan record;
    v_server_owner_id uuid;
    v_effective_perms bigint := 0;
    v_ev_allow bigint := 0;
    v_ev_deny bigint := 0;
    v_roles_allow bigint := 0;
    v_roles_deny bigint := 0;
    v_mem_allow bigint := 0;
    v_mem_deny bigint := 0;
    v_everyone_role_id uuid;
begin
    if p_user_id is null or p_message_id is null then
        raise exception 'Tham số user_id và message_id là bắt buộc' using errcode = '22023';
    end if;

    select id, conversation_id, channel_id, author_id, deleted_at
    into v_msg
    from public.messages
    where id = p_message_id;

    if not found then
        raise exception 'Không tìm thấy tin nhắn' using errcode = 'P0002';
    end if;

    -- Kiểm tra quyền xem tin nhắn
    if v_msg.conversation_id is not null then
        select exists(
            select 1 from public.conversation_participants
            where conversation_id = v_msg.conversation_id and user_id = p_user_id
        ) into v_is_member;

        if not v_is_member then
            raise exception 'Bạn không có quyền truy cập cuộc trò chuyện này' using errcode = '42501';
        end if;
    elsif v_msg.channel_id is not null then
        select c.id, c.server_id, s.owner_id into v_chan
        from public.channels c
        join public.servers s on c.server_id = s.id
        where c.id = v_msg.channel_id;

        if not found then
            raise exception 'Không tìm thấy kênh chứa tin nhắn' using errcode = 'P0002';
        end if;

        if v_chan.owner_id = p_user_id then
            v_effective_perms := ~0::bigint;
        else
            select id into v_everyone_role_id
            from public.roles
            where server_id = v_chan.server_id and is_default
            limit 1;

            select coalesce(bit_or(r.permissions), 0) into v_effective_perms
            from public.roles r
            where r.server_id = v_chan.server_id
              and (
                r.is_default
                or exists (
                    select 1 from public.member_roles mr
                    where mr.server_id = v_chan.server_id
                      and mr.user_id = p_user_id
                      and mr.role_id = r.id
                )
              );

            if (v_effective_perms & (1::bigint << 62)) <> 0 then
                v_effective_perms := ~0::bigint;
            else
                -- Overwrite @everyone trên channel
                if v_everyone_role_id is not null then
                    select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_ev_allow, v_ev_deny
                    from public.channel_overwrites co
                    where co.channel_id = v_msg.channel_id
                      and co.target_type = 'role'
                      and co.target_id = v_everyone_role_id
                    limit 1;
                    if found then
                        v_effective_perms := (v_effective_perms & ~v_ev_deny) | v_ev_allow;
                    end if;
                end if;

                -- Aggregate assigned roles overwrites
                select coalesce(bit_or(co.deny), 0), coalesce(bit_or(co.allow), 0) into v_roles_deny, v_roles_allow
                from public.channel_overwrites co
                join public.member_roles mr on co.target_id = mr.role_id
                where co.channel_id = v_msg.channel_id
                  and co.target_type = 'role'
                  and mr.server_id = v_chan.server_id
                  and mr.user_id = p_user_id;

                v_effective_perms := (v_effective_perms & ~v_roles_deny) | v_roles_allow;

                -- Member-specific overwrite
                select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_mem_allow, v_mem_deny
                from public.channel_overwrites co
                where co.channel_id = v_msg.channel_id
                  and co.target_type = 'member'
                  and co.target_id = p_user_id
                limit 1;

                if found then
                    v_effective_perms := (v_effective_perms & ~v_mem_deny) | v_mem_allow;
                end if;
            end if;
        end if;

        if (v_effective_perms & 1) = 0 then
            raise exception 'Bạn không có quyền xem tin nhắn trong kênh này' using errcode = '42501';
        end if;
    end if;

    -- Lưu trạng thái ẩn tin nhắn cho user
    insert into public.message_hidden_users(user_id, message_id)
    values (p_user_id, p_message_id)
    on conflict (user_id, message_id) do nothing;

    return jsonb_build_object(
        'id', p_message_id::text,
        'conversationId', v_msg.conversation_id,
        'channelId', v_msg.channel_id,
        'hidden', true
    );
end;
$$;

revoke all on function public.hide_message_for_user(uuid, bigint) from public, anon, authenticated;
grant execute on function public.hide_message_for_user(uuid, bigint) to service_role;

-- ----------------------------------------------------------------------------
-- 4. RPC: recall_message_for_everyone (Thu hồi tin nhắn nguyên tử cho mọi người)
-- ----------------------------------------------------------------------------
create or replace function public.recall_message_for_everyone(
    p_user_id    uuid,
    p_message_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_msg record;
    v_chan record;
    v_effective_perms bigint := 0;
    v_ev_allow bigint := 0;
    v_ev_deny bigint := 0;
    v_roles_allow bigint := 0;
    v_roles_deny bigint := 0;
    v_mem_allow bigint := 0;
    v_mem_deny bigint := 0;
    v_everyone_role_id uuid;
    v_storage_paths jsonb := '[]'::jsonb;
begin
    if p_user_id is null or p_message_id is null then
        raise exception 'Tham số user_id và message_id là bắt buộc' using errcode = '22023';
    end if;

    -- Khóa dòng tin nhắn chống race condition
    select id, conversation_id, channel_id, author_id, deleted_at
    into v_msg
    from public.messages
    where id = p_message_id
    for update;

    if not found then
        raise exception 'Không tìm thấy tin nhắn' using errcode = 'P0002';
    end if;

    -- Idempotent: Nếu đã bị thu hồi trước đó
    if v_msg.deleted_at is not null then
        return jsonb_build_object(
            'id', p_message_id::text,
            'conversationId', v_msg.conversation_id,
            'channelId', v_msg.channel_id,
            'recalled', true,
            'alreadyRecalled', true,
            'storagePaths', '[]'::jsonb
        );
    end if;

    -- Kiểm tra quyền thu hồi
    if v_msg.conversation_id is not null then
        if v_msg.author_id is distinct from p_user_id then
            raise exception 'Bạn chỉ có thể thu hồi tin nhắn của chính mình' using errcode = '42501';
        end if;
    elsif v_msg.channel_id is not null then
        if v_msg.author_id is distinct from p_user_id then
            -- Kiểm tra quyền MANAGE_MESSAGES (bit 4: 1n << 2n) hoặc ADMINISTRATOR (bit 1n << 62n) hoặc Server Owner
            select c.id, c.server_id, s.owner_id into v_chan
            from public.channels c
            join public.servers s on c.server_id = s.id
            where c.id = v_msg.channel_id;

            if not found then
                raise exception 'Không tìm thấy kênh chứa tin nhắn' using errcode = 'P0002';
            end if;

            if v_chan.owner_id = p_user_id then
                v_effective_perms := ~0::bigint;
            else
                select id into v_everyone_role_id
                from public.roles
                where server_id = v_chan.server_id and is_default
                limit 1;

                select coalesce(bit_or(r.permissions), 0) into v_effective_perms
                from public.roles r
                where r.server_id = v_chan.server_id
                  and (
                    r.is_default
                    or exists (
                        select 1 from public.member_roles mr
                        where mr.server_id = v_chan.server_id
                          and mr.user_id = p_user_id
                          and mr.role_id = r.id
                    )
                  );

                if (v_effective_perms & (1::bigint << 62)) <> 0 then
                    v_effective_perms := ~0::bigint;
                else
                    -- Overwrite @everyone trên channel
                    if v_everyone_role_id is not null then
                        select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_ev_allow, v_ev_deny
                        from public.channel_overwrites co
                        where co.channel_id = v_msg.channel_id
                          and co.target_type = 'role'
                          and co.target_id = v_everyone_role_id
                        limit 1;
                        if found then
                            v_effective_perms := (v_effective_perms & ~v_ev_deny) | v_ev_allow;
                        end if;
                    end if;

                    -- Aggregate assigned roles overwrites
                    select coalesce(bit_or(co.deny), 0), coalesce(bit_or(co.allow), 0) into v_roles_deny, v_roles_allow
                    from public.channel_overwrites co
                    join public.member_roles mr on co.target_id = mr.role_id
                    where co.channel_id = v_msg.channel_id
                      and co.target_type = 'role'
                      and mr.server_id = v_chan.server_id
                      and mr.user_id = p_user_id;

                    v_effective_perms := (v_effective_perms & ~v_roles_deny) | v_roles_allow;

                    -- Member-specific overwrite
                    select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_mem_allow, v_mem_deny
                    from public.channel_overwrites co
                    where co.channel_id = v_msg.channel_id
                      and co.target_type = 'member'
                      and co.target_id = p_user_id
                    limit 1;

                    if found then
                        v_effective_perms := (v_effective_perms & ~v_mem_deny) | v_mem_allow;
                    end if;
                end if;
            end if;

            if (v_effective_perms & 4) = 0 then
                raise exception 'Bạn không có quyền thu hồi tin nhắn này' using errcode = '42501';
            end if;
        end if;
    end if;

    -- 1. Thu thập attachments và enqueue vào storage_cleanup_outbox
    select coalesce(jsonb_agg(storage_path), '[]'::jsonb)
    into v_storage_paths
    from public.attachments
    where message_id = p_message_id;

    insert into public.storage_cleanup_outbox (
        bucket,
        storage_path,
        target_type,
        target_id,
        status,
        attempts,
        next_attempt_at,
        created_at,
        updated_at
    )
    select
        'message-attachments',
        a.storage_path,
        'message',
        p_message_id::text,
        'pending',
        0,
        clock_timestamp(),
        clock_timestamp(),
        clock_timestamp()
    from public.attachments a
    where a.message_id = p_message_id
    on conflict (bucket, storage_path) do nothing;

    -- 2. Xóa metadata attachments
    delete from public.attachments where message_id = p_message_id;

    -- 3. Xóa reactions nếu bảng tồn tại
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'message_reactions') then
        delete from public.message_reactions where message_id = p_message_id;
    end if;

    -- 4. Xóa external media (GIPHY) nếu có
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'message_external_media') then
        delete from public.message_external_media where message_id = p_message_id;
    end if;

    -- 5. Redact nội dung và đánh dấu deleted_at
    update public.messages
    set
        content = null,
        deleted_at = clock_timestamp()
    where id = p_message_id;

    return jsonb_build_object(
        'id', p_message_id::text,
        'conversationId', v_msg.conversation_id,
        'channelId', v_msg.channel_id,
        'recalled', true,
        'storagePaths', v_storage_paths
    );
end;
$$;

revoke all on function public.recall_message_for_everyone(uuid, bigint) from public, anon, authenticated;
grant execute on function public.recall_message_for_everyone(uuid, bigint) to service_role;

-- ----------------------------------------------------------------------------
-- 5. RPC: get_conversation_messages_paged (Lọc Hidden trước phân trang)
-- ----------------------------------------------------------------------------
create or replace function public.get_conversation_messages_paged(
    p_conversation_id uuid,
    p_user_id         uuid,
    p_limit           int default 50,
    p_before          bigint default null,
    p_after           bigint default null
)
returns table (
    id              bigint,
    channel_id      uuid,
    conversation_id uuid,
    author_id       uuid,
    type            public.message_type,
    content         text,
    reply_to_id     bigint,
    sticker_provider text,
    sticker_id       text,
    sticker_url      text,
    client_nonce    uuid,
    is_forwarded    boolean,
    edited_at       timestamptz,
    deleted_at      timestamptz,
    created_at      timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
    select 
        m.id,
        m.channel_id,
        m.conversation_id,
        m.author_id,
        m.type,
        m.content,
        m.reply_to_id,
        m.sticker_provider,
        m.sticker_id,
        m.sticker_url,
        m.client_nonce,
        coalesce(m.is_forwarded, false) as is_forwarded,
        m.edited_at,
        m.deleted_at,
        m.created_at
    from public.messages m
    where m.conversation_id = p_conversation_id
      and not exists (
          select 1
          from public.message_hidden_users h
          where h.user_id = p_user_id
            and h.message_id = m.id
      )
      and (p_before is null or m.id < p_before)
      and (p_after is null or m.id > p_after)
    order by m.id desc
    limit p_limit + 1;
$$;

revoke all on function public.get_conversation_messages_paged(uuid, uuid, int, bigint, bigint) from public, anon, authenticated;
grant execute on function public.get_conversation_messages_paged(uuid, uuid, int, bigint, bigint) to service_role;

-- ----------------------------------------------------------------------------
-- 6. RPC: get_channel_messages_paged (Lọc Hidden trước phân trang)
-- ----------------------------------------------------------------------------
create or replace function public.get_channel_messages_paged(
    p_channel_id uuid,
    p_user_id    uuid,
    p_limit      int default 50,
    p_before     bigint default null,
    p_after      bigint default null
)
returns table (
    id              bigint,
    channel_id      uuid,
    conversation_id uuid,
    author_id       uuid,
    type            public.message_type,
    content         text,
    reply_to_id     bigint,
    sticker_provider text,
    sticker_id       text,
    sticker_url      text,
    client_nonce    uuid,
    is_forwarded    boolean,
    edited_at       timestamptz,
    deleted_at      timestamptz,
    created_at      timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
    select 
        m.id,
        m.channel_id,
        m.conversation_id,
        m.author_id,
        m.type,
        m.content,
        m.reply_to_id,
        m.sticker_provider,
        m.sticker_id,
        m.sticker_url,
        m.client_nonce,
        coalesce(m.is_forwarded, false) as is_forwarded,
        m.edited_at,
        m.deleted_at,
        m.created_at
    from public.messages m
    where m.channel_id = p_channel_id
      and not exists (
          select 1
          from public.message_hidden_users h
          where h.user_id = p_user_id
            and h.message_id = m.id
      )
      and (p_before is null or m.id < p_before)
      and (p_after is null or m.id > p_after)
    order by m.id desc
    limit p_limit + 1;
$$;

revoke all on function public.get_channel_messages_paged(uuid, uuid, int, bigint, bigint) from public, anon, authenticated;
grant execute on function public.get_channel_messages_paged(uuid, uuid, int, bigint, bigint) to service_role;
