-- ============================================================================
-- Migration: Live Server Channel Messages & Channel Management RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RPC: create_channel_message
-- Ghi tin nhắn và tệp đính kèm nguyên tử, kiểm tra quyền hạn và idempotency
-- ----------------------------------------------------------------------------
create or replace function public.create_channel_message(
    p_channel_id    uuid,
    p_author_id     uuid,
    p_content       text,
    p_client_nonce  uuid,
    p_reply_to_id   bigint default null,
    p_attachments   jsonb default '[]'::jsonb,
    p_is_forwarded  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_chan             record;
    v_server_owner_id  uuid;
    v_member_role      text;
    v_everyone_role_id uuid;
    v_base_perms       bigint := 0;
    v_is_admin         boolean := false;
    v_effective_perms  bigint := 0;
    v_ev_allow         bigint := 0;
    v_ev_deny          bigint := 0;
    v_roles_allow      bigint := 0;
    v_roles_deny       bigint := 0;
    v_mem_allow        bigint := 0;
    v_mem_deny         bigint := 0;
    v_reply_chan_id    uuid;
    v_existing_msg     record;
    v_msg_id           bigint;
    v_created_at       timestamptz;
    v_att_count        integer := 0;
    v_total_bytes      bigint := 0;
    v_att_elem         jsonb;
    v_att_path         text;
    v_att_filename     text;
    v_att_mime         text;
    v_att_size         bigint;
    v_att_width        integer;
    v_att_height       integer;
    v_att_id           uuid;
    v_att_list         jsonb := '[]'::jsonb;
    v_author_rec       record;
    v_trimmed_content  text;
begin
    -- 1. Kiểm tra tham số cơ bản
    if p_channel_id is null or p_author_id is null or p_client_nonce is null then
        raise exception 'Tham số channel_id, author_id và client_nonce là bắt buộc' using errcode = '22023';
    end if;

    if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
        raise exception 'Danh sách attachments phải là một JSON array hợp lệ' using errcode = '22023';
    end if;

    v_trimmed_content := p_content;
    if (v_trimmed_content is null or trim(v_trimmed_content) = '') and jsonb_array_length(p_attachments) = 0 then
        raise exception 'Tin nhắn phải có nội dung văn bản hoặc tệp đính kèm' using errcode = '22023';
    end if;

    if v_trimmed_content is not null and char_length(v_trimmed_content) > 4000 then
        raise exception 'Nội dung tin nhắn không được vượt quá 4000 ký tự' using errcode = '22023';
    end if;

    -- 2. Kiểm tra tồn tại của channel và loại kênh
    select id, server_id, type into v_chan
    from public.channels
    where id = p_channel_id;

    if not found then
        raise exception 'Kênh không tồn tại hoặc đã bị xóa' using errcode = 'P0002';
    end if;

    if v_chan.type <> 'text' then
        raise exception 'Không thể gửi tin nhắn văn bản vào kênh thoại' using errcode = '22023';
    end if;

    -- 3. Kiểm tra membership máy chủ
    select owner_id into v_server_owner_id
    from public.servers
    where id = v_chan.server_id;

    if not found then
        raise exception 'Máy chủ không tồn tại' using errcode = 'P0002';
    end if;

    select role into v_member_role
    from public.server_members
    where server_id = v_chan.server_id and user_id = p_author_id;

    if not found then
        raise exception 'Bạn không phải là thành viên của máy chủ này' using errcode = '42501';
    end if;

    -- 4. Tính toán quyền hiệu lực (Effective Permissions) theo thuật toán 5 bước
    -- Bước 1: Owner hoặc ADMIN role
    if v_server_owner_id = p_author_id or v_member_role = 'OWNER' or v_member_role = 'ADMIN' then
        v_is_admin := true;
    end if;

    if not v_is_admin then
        -- Bước 2: Base perms (@everyone + member roles)
        select id into v_everyone_role_id
        from public.roles
        where server_id = v_chan.server_id and is_default
        limit 1;

        select coalesce(bit_or(r.permissions), 0) into v_base_perms
        from public.roles r
        where r.server_id = v_chan.server_id
          and (
            r.is_default
            or exists (
                select 1 from public.member_roles mr
                where mr.server_id = v_chan.server_id
                  and mr.user_id = p_author_id
                  and mr.role_id = r.id
            )
          );

        -- Kiểm tra bit ADMINISTRATOR (1 << 62)
        if (v_base_perms & (1::bigint << 62)) <> 0 then
            v_is_admin := true;
        end if;
    end if;

    if v_is_admin then
        v_effective_perms := ~0::bigint;
    else
        v_effective_perms := v_base_perms;

        -- Bước 3: @everyone overwrite trên channel (target_type = 'role', target_id = v_everyone_role_id)
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

        -- Bước 4: Aggregate assigned roles overwrites (target_type = 'role', target_id = mr.role_id)
        select coalesce(bit_or(co.deny), 0), coalesce(bit_or(co.allow), 0) into v_roles_deny, v_roles_allow
        from public.channel_overwrites co
        join public.member_roles mr on co.target_id = mr.role_id
        where co.channel_id = p_channel_id
          and co.target_type = 'role'
          and mr.server_id = v_chan.server_id
          and mr.user_id = p_author_id;

        v_effective_perms := (v_effective_perms & ~v_roles_deny) | v_roles_allow;

        -- Bước 5: Member-specific overwrite (target_type = 'member', target_id = p_author_id)
        select coalesce(co.allow, 0), coalesce(co.deny, 0) into v_mem_allow, v_mem_deny
        from public.channel_overwrites co
        where co.channel_id = p_channel_id
          and co.target_type = 'member'
          and co.target_id = p_author_id
        limit 1;

        if found then
            v_effective_perms := (v_effective_perms & ~v_mem_deny) | v_mem_allow;
        end if;
    end if;

    -- Kiểm tra bit VIEW_CHANNEL (bit 0 = 1) và SEND_MESSAGES (bit 1 = 2)
    if (v_effective_perms & 1) = 0 or (v_effective_perms & 2) = 0 then
        raise exception 'Bạn không có quyền gửi tin nhắn trong kênh này' using errcode = '42501';
    end if;

    -- Kiểm tra số lượng & dung lượng attachments
    v_att_count := jsonb_array_length(p_attachments);

    if v_att_count > 0 then
        -- Kiểm tra bit ATTACH_FILES (bit 3 = 8)
        if (v_effective_perms & 8) = 0 then
            raise exception 'Bạn không có quyền đính kèm tệp trong kênh này' using errcode = '42501';
        end if;

        if v_att_count > 5 then
            raise exception 'Tối đa 5 tệp đính kèm cho mỗi tin nhắn' using errcode = '22023';
        end if;
    end if;

    -- 5. Kiểm tra reply_to_id
    if p_reply_to_id is not null then
        select channel_id into v_reply_chan_id
        from public.messages
        where id = p_reply_to_id;

        if not found or v_reply_chan_id is null or v_reply_chan_id <> p_channel_id then
            raise exception 'Tin nhắn phản hồi không thuộc cùng một kênh' using errcode = '22023';
        end if;
    end if;

    -- 6. Idempotency & Duplicate Nonce pre-check
    select id, channel_id, conversation_id
    into v_existing_msg
    from public.messages
    where author_id = p_author_id and client_nonce = p_client_nonce;

    if found then
        if v_existing_msg.channel_id <> p_channel_id then
            raise exception 'Client nonce đã được sử dụng cho cuộc trò chuyện hoặc kênh khác' using errcode = '23505';
        else
            raise exception 'Client nonce đã tồn tại' using errcode = '23505';
        end if;
    end if;

    -- 7. Validate metadata từng attachment (Defense-in-depth)
    if v_att_count > 0 then
        for i in 0 .. (v_att_count - 1) loop
            v_att_elem := p_attachments -> i;
            v_att_path := v_att_elem ->> 'storage_path';
            v_att_filename := v_att_elem ->> 'filename';
            v_att_mime := v_att_elem ->> 'mime_type';
            v_att_size := (v_att_elem ->> 'size_bytes')::bigint;
            v_att_width := case when v_att_elem ? 'width' and v_att_elem ->> 'width' is not null then (v_att_elem ->> 'width')::integer else null end;
            v_att_height := case when v_att_elem ? 'height' and v_att_elem ->> 'height' is not null then (v_att_elem ->> 'height')::integer else null end;

            if v_att_path is null or trim(v_att_path) = '' or
               v_att_filename is null or trim(v_att_filename) = '' or
               v_att_mime is null or trim(v_att_mime) = '' or
               v_att_size is null then
                raise exception 'Dữ liệu tệp đính kèm không hợp lệ' using errcode = '22023';
            end if;

            if v_att_size <= 0 or v_att_size > 10485760 then
                raise exception 'Mỗi tệp đính kèm không được vượt quá 10MB' using errcode = '22023';
            end if;

            if v_att_width is not null and v_att_width <= 0 then
                raise exception 'Chiều rộng tệp ảnh không hợp lệ' using errcode = '22023';
            end if;

            if v_att_height is not null and v_att_height <= 0 then
                raise exception 'Chiều cao tệp ảnh không hợp lệ' using errcode = '22023';
            end if;

            -- Canonical MIME whitelist (bao gồm DOCX)
            if v_att_mime not in (
                'image/jpeg', 'image/png', 'image/webp', 'image/gif',
                'application/pdf', 'text/plain',
                'application/zip', 'application/x-zip-compressed',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            ) then
                raise exception 'Loại tệp không nằm trong danh sách cho phép' using errcode = '22023';
            end if;

            -- Security path checks: chặn .., \, //
            if v_att_path like '%..%' or v_att_path like '%\%' or v_att_path like '%//%' then
                raise exception 'Đường dẫn lưu trữ tệp không hợp lệ' using errcode = '22023';
            end if;

            -- Regex check: channels/<channel_id>/<uuid>.<ext>
            if not (v_att_path ~* ('^channels/' || p_channel_id::text || '/[0-9a-fA-F-]{36}\.[a-zA-Z0-9]+$')) then
                raise exception 'Đường dẫn lưu trữ tệp đính kèm không hợp lệ cho kênh này' using errcode = '22023';
            end if;

            v_total_bytes := v_total_bytes + v_att_size;
            if v_total_bytes > 31457280 then
                raise exception 'Tổng dung lượng tệp đính kèm không được vượt quá 30MB' using errcode = '22023';
            end if;
        end loop;
    end if;

    -- 8. Ghi bản ghi vào public.messages (khi concurrent duplicate nonce xảy ra, unique constraint tự raise 23505)
    insert into public.messages (
        channel_id,
        author_id,
        type,
        content,
        reply_to_id,
        client_nonce,
        is_forwarded
    ) values (
        p_channel_id,
        p_author_id,
        'default',
        v_trimmed_content,
        p_reply_to_id,
        p_client_nonce,
        coalesce(p_is_forwarded, false)
    )
    returning id, created_at into v_msg_id, v_created_at;

    -- 9. Ghi attachments metadata nguyên tử
    v_att_list := '[]'::jsonb;
    if v_att_count > 0 then
        for i in 0 .. (v_att_count - 1) loop
            v_att_elem := p_attachments -> i;
            v_att_path := v_att_elem ->> 'storage_path';
            v_att_filename := v_att_elem ->> 'filename';
            v_att_mime := v_att_elem ->> 'mime_type';
            v_att_size := (v_att_elem ->> 'size_bytes')::bigint;
            v_att_width := case when v_att_elem ? 'width' and v_att_elem ->> 'width' is not null then (v_att_elem ->> 'width')::integer else null end;
            v_att_height := case when v_att_elem ? 'height' and v_att_elem ->> 'height' is not null then (v_att_elem ->> 'height')::integer else null end;

            insert into public.attachments (
                message_id,
                storage_path,
                filename,
                mime_type,
                size_bytes,
                width,
                height
            ) values (
                v_msg_id,
                v_att_path,
                v_att_filename,
                v_att_mime,
                v_att_size,
                v_att_width,
                v_att_height
            )
            returning id into v_att_id;

            v_att_list := v_att_list || jsonb_build_object(
                'id', v_att_id,
                'filename', v_att_filename,
                'mimeType', v_att_mime,
                'sizeBytes', v_att_size,
                'width', v_att_width,
                'height', v_att_height,
                'storagePath', v_att_path
            );
        end loop;
    end if;

    -- Lấy author profile
    select username, display_name, avatar_url into v_author_rec
    from public.profiles where id = p_author_id;

    return jsonb_build_object(
        'id', v_msg_id::text,
        'channelId', p_channel_id,
        'conversationId', null,
        'authorId', p_author_id,
        'author', jsonb_build_object(
            'id', p_author_id,
            'username', coalesce(v_author_rec.username, ''),
            'displayName', coalesce(v_author_rec.display_name, v_author_rec.username, 'User'),
            'avatarUrl', v_author_rec.avatar_url
        ),
        'type', 'default',
        'content', v_trimmed_content,
        'replyToId', case when p_reply_to_id is not null then p_reply_to_id::text else null end,
        'clientNonce', p_client_nonce,
        'editedAt', null,
        'deletedAt', null,
        'isForwarded', coalesce(p_is_forwarded, false),
        'attachments', v_att_list,
        'reactions', '[]'::jsonb,
        'createdAt', v_created_at
    );
end;
$$;

revoke all on function public.create_channel_message(uuid, uuid, text, uuid, bigint, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_channel_message(uuid, uuid, text, uuid, bigint, jsonb, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- 2. RPC: update_server_channel
-- Cập nhật tên và topic của kênh có kiểm tra quyền MANAGE_CHANNELS và chống IDOR
-- ----------------------------------------------------------------------------
create or replace function public.update_server_channel(
    p_server_id  uuid,
    p_channel_id uuid,
    p_user_id    uuid,
    p_name       text,
    p_topic      text default null
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
    v_trimmed_name    text;
    v_sanitized_topic text;
    v_updated_chan    record;
begin
    if p_server_id is null or p_channel_id is null or p_user_id is null or p_name is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    -- Advisory transaction lock để tuần tự hóa các thao tác trên server channels
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_server_id::text, 0));

    v_trimmed_name := trim(p_name);
    if char_length(v_trimmed_name) < 2 or char_length(v_trimmed_name) > 100 then
        raise exception 'Tên kênh phải từ 2 đến 100 ký tự' using errcode = '22023';
    end if;

    -- Chặn ký tự điều khiển (control characters) trong tên kênh
    if v_trimmed_name ~ '[\x00-\x1F\x7F]' then
        raise exception 'Tên kênh chứa ký tự không hợp lệ' using errcode = '22023';
    end if;

    -- Sanitize và kiểm tra topic tối đa 1024 ký tự
    v_sanitized_topic := nullif(trim(p_topic), '');
    if v_sanitized_topic is not null and char_length(v_sanitized_topic) > 1024 then
        raise exception 'Chủ đề kênh không được vượt quá 1024 ký tự' using errcode = '22023';
    end if;

    -- Kiểm tra channel thuộc đúng server_id (chống IDOR)
    select id, server_id, name, type, topic, position
    into v_chan
    from public.channels
    where id = p_channel_id and server_id = p_server_id;

    if not found then
        raise exception 'Kênh không tồn tại trong máy chủ này' using errcode = 'P0002';
    end if;

    -- Kiểm tra quyền MANAGE_CHANNELS (bit 4 = 16)
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

    -- Cập nhật kênh
    begin
        update public.channels
        set
            name = v_trimmed_name,
            topic = v_sanitized_topic
        where id = p_channel_id and server_id = p_server_id
        returning id, server_id, name, type, topic, position into v_updated_chan;
    exception when unique_violation then
        raise exception 'Tên kênh đã tồn tại trong máy chủ này' using errcode = '23505';
    end;

    return jsonb_build_object(
        'id', v_updated_chan.id,
        'serverId', v_updated_chan.server_id,
        'name', v_updated_chan.name,
        'type', v_updated_chan.type,
        'topic', v_updated_chan.topic,
        'position', v_updated_chan.position,
        'unread', false,
        'mentionCount', 0
    );
end;
$$;

revoke all on function public.update_server_channel(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_server_channel(uuid, uuid, uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 3. RPC: delete_server_channel
-- Xóa kênh có kiểm tra MANAGE_CHANNELS và bảo vệ text channel duy nhất còn lại
-- ----------------------------------------------------------------------------
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

    -- Xóa channel
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
