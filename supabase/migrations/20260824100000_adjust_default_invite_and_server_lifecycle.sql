-- ============================================================================
-- Migration: Checkpoint 11.1 — Remove default CREATE_INVITE, add delete_server & leave_server RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Điều chỉnh quyền mặc định @everyone: Gỡ bỏ CREATE_INVITE (256)
--    Quyền mới: 3339 - 256 = 3083
--    Chỉ cập nhật khi role @everyone mặc định đang chứa bit 256
-- ---------------------------------------------------------------------------
update public.roles
set permissions = permissions & ~256::bigint
where is_default = true
  and (permissions & 256::bigint) <> 0;

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
        3083::bigint, -- VIEW_CHANNEL(1) | SEND_MESSAGES(2) | ATTACH_FILES(8) | CONNECT_VOICE(1024) | SPEAK_VOICE(2048) = 3083 (Không chứa CREATE_INVITE = 256n hay MANAGE_CHANNELS = 16n)
        0,
        true
    )
    returning id into v_role_id;

    return v_role_id;
end;
$$;

-- Cập nhật RPC create_server_with_template để khởi tạo @everyone với 3083
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
        3083::bigint, -- VIEW_CHANNEL(1) | SEND_MESSAGES(2) | ATTACH_FILES(8) | CONNECT_VOICE(1024) | SPEAK_VOICE(2048) = 3083 (Không chứa bit 256 CREATE_INVITE hay bit 16 MANAGE_CHANNELS)
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

-- ---------------------------------------------------------------------------
-- 2. RPC delete_server (Chỉ dành cho Owner)
--    Thu thập memberUserIds trước khi CASCADE delete để phát realtime
-- ---------------------------------------------------------------------------
create or replace function public.delete_server(
    p_server_id uuid,
    p_user_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_owner_id      uuid;
    v_member_ids    jsonb;
begin
    if p_server_id is null or p_user_id is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_server_id::text, 0));

    select owner_id into v_owner_id
    from public.servers
    where id = p_server_id
    for update;

    if not found then
        raise exception 'Máy chủ không tồn tại'
            using errcode = 'P0002';
    end if;

    if v_owner_id <> p_user_id then
        raise exception 'Chỉ chủ sở hữu máy chủ mới có quyền xóa máy chủ'
            using errcode = '42501';
    end if;

    select coalesce(jsonb_agg(user_id), '[]'::jsonb)
    into v_member_ids
    from public.server_members
    where server_id = p_server_id;

    delete from public.servers
    where id = p_server_id;

    return jsonb_build_object(
        'success', true,
        'serverId', p_server_id,
        'memberUserIds', v_member_ids
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RPC leave_server (Dành cho Non-Owner, Idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.leave_server(
    p_server_id uuid,
    p_user_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_owner_id      uuid;
    v_is_member     boolean;
begin
    if p_server_id is null or p_user_id is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_server_id::text, 0));

    select owner_id into v_owner_id
    from public.servers
    where id = p_server_id;

    if not found then
        return jsonb_build_object(
            'success', true,
            'serverId', p_server_id,
            'alreadyLeft', true
        );
    end if;

    if v_owner_id = p_user_id then
        return jsonb_build_object(
            'success', false,
            'reason', 'owner_cannot_leave',
            'message', 'Chủ sở hữu không thể rời máy chủ. Vui lòng chuyển quyền sở hữu hoặc xóa máy chủ.'
        );
    end if;

    select exists (
        select 1
        from public.server_members
        where server_id = p_server_id
          and user_id = p_user_id
    ) into v_is_member;

    if not v_is_member then
        return jsonb_build_object(
            'success', true,
            'serverId', p_server_id,
            'alreadyLeft', true
        );
    end if;

    delete from public.member_roles
    where server_id = p_server_id
      and user_id = p_user_id;

    delete from public.server_members
    where server_id = p_server_id
      and user_id = p_user_id;

    return jsonb_build_object(
        'success', true,
        'serverId', p_server_id,
        'alreadyLeft', false
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Phân quyền thực thi: Chỉ cho phép service_role
-- ---------------------------------------------------------------------------
revoke execute on function public.create_default_role(uuid) from public, anon, authenticated;
grant execute on function public.create_default_role(uuid) to service_role;

revoke execute on function public.create_server_with_template(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_server_with_template(uuid, text, text, jsonb) to service_role;

revoke execute on function public.delete_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_server(uuid, uuid) to service_role;

revoke execute on function public.leave_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.leave_server(uuid, uuid) to service_role;
