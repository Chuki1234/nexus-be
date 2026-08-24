-- ============================================================================
-- Migration: Checkpoint 12.1 — Restore default CREATE_INVITE (3339) & Storage Cleanup Outbox
-- LOCAL ONLY — Tuyệt đối không áp dụng remote Supabase
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Điều chỉnh quyền mặc định @everyone: Khôi phục CREATE_INVITE (256)
--    Quyền chuẩn: 3083 + 256 = 3339
--    (VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | CREATE_INVITE | CONNECT_VOICE | SPEAK_VOICE)
--    Chỉ cập nhật khi role @everyone mặc định đang có đúng giá trị 3083
-- ---------------------------------------------------------------------------
update public.roles
set permissions = 3339::bigint
where is_default = true
  and permissions = 3083::bigint;

-- Cập nhật hàm tạo role mặc định cho server mới
create or replace function public.create_default_role(
    p_server_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_role_id uuid;
begin
    insert into public.roles (
        server_id,
        name,
        permissions,
        position,
        is_default
    )
    values (
        p_server_id,
        '@everyone',
        3339::bigint, -- VIEW_CHANNEL(1) | SEND_MESSAGES(2) | ATTACH_FILES(8) | CREATE_INVITE(256) | CONNECT_VOICE(1024) | SPEAK_VOICE(2048) = 3339
        0,
        true
    )
    returning id into v_role_id;

    return v_role_id;
end;
$$;

revoke all on function public.create_default_role(uuid) from public, anon, authenticated;
grant execute on function public.create_default_role(uuid) to service_role;

-- Đảm bảo template_id cho phép null khi khởi tạo server tự do không theo template
alter table public.servers alter column template_id drop not null;

-- Cập nhật RPC create_server_with_template để khởi tạo @everyone với 3339
create or replace function public.create_server_with_template(
    p_owner_id    uuid,
    p_name        text,
    p_template_id text default null,
    p_channels    jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_server_id    uuid;
    v_clean_name   text;
    v_channel      jsonb;
    v_channel_name text;
    v_channel_type public.channel_type;
    v_position     integer;
    v_topic        text;
    v_channels_out jsonb := '[]'::jsonb;
    v_ch_id        uuid;
    v_ch_name_out  text;
    v_ch_type_out  public.channel_type;
    v_ch_topic_out text;
begin
    v_clean_name := trim(p_name);
    if v_clean_name is null or length(v_clean_name) < 2 or length(v_clean_name) > 100 then
        raise exception 'Tên máy chủ phải từ 2 đến 100 ký tự'
            using errcode = '22023';
    end if;

    insert into public.servers (
        name,
        template_id,
        owner_id
    )
    values (
        v_clean_name,
        nullif(trim(p_template_id), ''::text),
        p_owner_id
    )
    returning id into v_server_id;

    insert into public.server_members (
        server_id,
        user_id,
        role
    )
    values (
        v_server_id,
        p_owner_id,
        'OWNER'
    );

    insert into public.roles (
        server_id,
        name,
        permissions,
        position,
        is_default
    )
    values (
        v_server_id,
        '@everyone',
        3339::bigint, -- VIEW_CHANNEL(1) | SEND_MESSAGES(2) | ATTACH_FILES(8) | CREATE_INVITE(256) | CONNECT_VOICE(1024) | SPEAK_VOICE(2048) = 3339
        0,
        true
    );

    if p_channels is not null and jsonb_array_length(p_channels) > 0 then
        for v_channel in select * from jsonb_array_elements(p_channels)
        loop
            v_channel_name := trim(v_channel->>'name');
            if v_channel_name is null or length(v_channel_name) < 1 or length(v_channel_name) > 100 then
                continue;
            end if;

            begin
                v_channel_type := (v_channel->>'type')::public.channel_type;
            exception when others then
                v_channel_type := 'text'::public.channel_type;
            end;

            v_position := coalesce((v_channel->>'position')::integer, 0);
            v_topic    := nullif(trim(v_channel->>'topic'), ''::text);

            insert into public.channels (
                server_id,
                name,
                type,
                position,
                topic
            )
            values (
                v_server_id,
                v_channel_name,
                v_channel_type,
                v_position,
                v_topic
            )
            returning id, name, type, topic
            into v_ch_id, v_ch_name_out, v_ch_type_out, v_ch_topic_out;

            v_channels_out := v_channels_out || jsonb_build_object(
                'id', v_ch_id,
                'name', v_ch_name_out,
                'type', v_ch_type_out,
                'topic', v_ch_topic_out,
                'unread', false,
                'mentionCount', 0
            );
        end loop;
    end if;

    -- Nhánh default channel: Trả về JSON array chuẩn mực bằng jsonb_build_array
    if jsonb_array_length(v_channels_out) = 0 then
        insert into public.channels (
            server_id,
            name,
            type,
            position,
            topic
        )
        values (
            v_server_id,
            'chung',
            'text'::public.channel_type,
            0,
            'Kênh trò chuyện chung'
        )
        returning id, name, type, topic
        into v_ch_id, v_ch_name_out, v_ch_type_out, v_ch_topic_out;

        v_channels_out := jsonb_build_array(jsonb_build_object(
            'id', v_ch_id,
            'name', v_ch_name_out,
            'type', v_ch_type_out,
            'topic', v_ch_topic_out,
            'unread', false,
            'mentionCount', 0
        ));
    end if;

    return jsonb_build_object(
        'server', jsonb_build_object(
            'id', v_server_id,
            'name', v_clean_name,
            'iconUrl', null,
            'unread', false,
            'mentionCount', 0
        ),
        'channels', v_channels_out
    );
end;
$$;

revoke all on function public.create_server_with_template(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_server_with_template(uuid, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tạo bảng storage_cleanup_outbox cho Worker dọn dẹp Storage bất đồng bộ
-- ---------------------------------------------------------------------------
create table if not exists public.storage_cleanup_outbox (
    id uuid primary key default gen_random_uuid(),
    bucket text not null default 'message-attachments',
    storage_path text not null,
    target_type text not null,
    target_id text not null,
    status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
    attempts int not null default 0,
    next_attempt_at timestamptz not null default now(),
    locked_at timestamptz,
    locked_by text,
    lease_expires_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint uq_storage_cleanup_bucket_path unique (bucket, storage_path)
);

create index if not exists idx_storage_cleanup_outbox_queue
on public.storage_cleanup_outbox (status, next_attempt_at)
where status in ('pending', 'processing', 'failed');

alter table public.storage_cleanup_outbox enable row level security;
revoke all on public.storage_cleanup_outbox from public, anon, authenticated;
grant all on public.storage_cleanup_outbox to service_role;

-- ---------------------------------------------------------------------------
-- 3. Cập nhật delete_server_channel RPC:
--    Ghi storage paths vào storage_cleanup_outbox trước khi CASCADE delete
-- ---------------------------------------------------------------------------
create or replace function public.delete_server_channel(
    p_server_id  uuid,
    p_channel_id uuid,
    p_user_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_chan            record;
    v_server_owner_id uuid;
    v_member_role     text;
    v_everyone_role_id uuid;
    v_base_perms      bigint := 0;
    v_is_admin        boolean := false;
    v_effective_perms bigint := 0;
    v_ev_allow        bigint := 0;
    v_ev_deny         bigint := 0;
    v_roles_allow     bigint := 0;
    v_roles_deny      bigint := 0;
    v_mem_allow       bigint := 0;
    v_mem_deny        bigint := 0;
    v_text_count      integer := 0;
begin
    if p_server_id is null or p_channel_id is null or p_user_id is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    -- Advisory transaction lock để tuần tự hóa các thao tác xóa kênh, chống race condition xóa đồng thời 2 kênh chữ cuối
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_server_id::text, 0));

    -- Kiểm tra channel thuộc đúng server_id
    select id, server_id, type
    into v_chan
    from public.channels
    where id = p_channel_id and server_id = p_server_id;

    if not found then
        raise exception 'Kênh không tồn tại trong máy chủ này' using errcode = 'P0002';
    end if;

    -- Kiểm tra quyền MANAGE_CHANNELS
    select owner_id into v_server_owner_id
    from public.servers
    where id = p_server_id;

    if not found then
        raise exception 'Máy chủ không tồn tại' using errcode = 'P0002';
    end if;

    select role into v_member_role
    from public.server_members
    where server_id = p_server_id and user_id = p_user_id;

    if not found then
        raise exception 'Bạn không phải là thành viên của máy chủ này' using errcode = '42501';
    end if;

    if v_server_owner_id = p_user_id or v_member_role = 'OWNER' or v_member_role = 'ADMIN' then
        v_is_admin := true;
    end if;

    if not v_is_admin then
        select id into v_everyone_role_id
        from public.roles
        where server_id = p_server_id and is_default
        limit 1;

        select coalesce(bit_or(r.permissions), 0) into v_base_perms
        from public.roles r
        where r.server_id = p_server_id
          and (
            r.is_default
            or exists (
                select 1 from public.member_roles mr
                where mr.server_id = p_server_id
                  and mr.user_id = p_user_id
                  and mr.role_id = r.id
            )
          );

        if (v_base_perms & (1::bigint << 62)) <> 0 then
            v_is_admin := true;
        end if;
    end if;

    if v_is_admin then
        v_effective_perms := ~0::bigint;
    else
        v_effective_perms := v_base_perms;

        -- Overwrites
        if v_everyone_role_id is not null then
            select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_ev_allow, v_ev_deny
            from public.channel_overwrites co
            where co.channel_id = p_channel_id
              and co.target_type = 'role'
              and co.target_id = v_everyone_role_id
            limit 1;

            if found then
                v_effective_perms := (v_effective_perms & ~v_ev_deny) | v_ev_allow;
            end if;
        end if;

        select coalesce(bit_or(co.deny), 0), coalesce(bit_or(co.allow), 0) into v_roles_deny, v_roles_allow
        from public.channel_overwrites co
        join public.member_roles mr on co.target_id = mr.role_id
        where co.channel_id = p_channel_id
          and co.target_type = 'role'
          and mr.server_id = p_server_id
          and mr.user_id = p_user_id;

        v_effective_perms := (v_effective_perms & ~v_roles_deny) | v_roles_allow;

        select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_mem_allow, v_mem_deny
        from public.channel_overwrites co
        where co.channel_id = p_channel_id
          and co.target_type = 'member'
          and co.target_id = p_user_id
        limit 1;

        if found then
            v_effective_perms := (v_effective_perms & ~v_mem_deny) | v_mem_allow;
        end if;
    end if;

    if (v_effective_perms & 16) = 0 and (v_effective_perms & (1::bigint << 62)) = 0 then
        raise exception 'Bạn không có quyền quản lý kênh trong máy chủ này' using errcode = '42501';
    end if;

    -- Kiểm tra quy tắc bảo toàn: Không cho phép xóa kênh chữ cuối cùng
    if v_chan.type = 'text' then
        select count(*) into v_text_count
        from public.channels
        where server_id = p_server_id and type = 'text';

        if v_text_count <= 1 then
            raise exception 'Không thể xóa kênh chữ duy nhất còn lại của máy chủ' using errcode = '22023';
        end if;
    end if;

    -- Ghi danh sách attachments vào storage_cleanup_outbox trước khi CASCADE delete
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
        'channel',
        p_channel_id::text,
        'pending',
        0,
        now(),
        now(),
        now()
    from public.attachments a
    inner join public.messages m on m.id = a.message_id
    where m.channel_id = p_channel_id
      and a.storage_path is not null
      and a.storage_path <> ''
    on conflict (bucket, storage_path) do update
    set status = 'pending',
        attempts = 0,
        next_attempt_at = now(),
        updated_at = now();

    -- Xóa channel (CASCADE xóa messages & attachments trong DB)
    delete from public.channels
    where id = p_channel_id and server_id = p_server_id;

    return jsonb_build_object(
        'success', true,
        'channelId', p_channel_id,
        'serverId', p_server_id
    );
end;
$$;

revoke all on function public.delete_server_channel(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_server_channel(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. RPC claim_storage_cleanup_batch cho Worker dọn dẹp Storage (FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------
create or replace function public.claim_storage_cleanup_batch(
    p_worker_id text,
    p_limit     integer default 50
)
returns table (
    id           uuid,
    bucket       text,
    storage_path text,
    attempts     integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    return query
    update public.storage_cleanup_outbox o
    set status = 'processing',
        locked_by = p_worker_id,
        locked_at = now(),
        lease_expires_at = now() + interval '30 seconds',
        updated_at = now()
    where o.id in (
        select sub.id
        from public.storage_cleanup_outbox sub
        where (sub.status = 'pending'
               or (sub.status = 'processing' and sub.lease_expires_at < now())
               or (sub.status = 'failed' and sub.attempts < 5))
          and sub.next_attempt_at <= now()
        order by sub.next_attempt_at asc
        limit coalesce(p_limit, 50)
        for update skip locked
    )
    returning o.id, o.bucket, o.storage_path, o.attempts;
end;
$$;

revoke all on function public.claim_storage_cleanup_batch(text, integer) from public, anon, authenticated;
grant execute on function public.claim_storage_cleanup_batch(text, integer) to service_role;

