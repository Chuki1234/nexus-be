-- ============================================================================
-- Migration: GIPHY External Media & Atomic Message RPCs (Checkpoint 12.4)
-- LOCAL ONLY — Not applied to remote Supabase
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Bảng public.message_external_media
-- Lưu trữ metadata tham chiếu đến GIPHY (không upload vào Supabase Storage)
-- ----------------------------------------------------------------------------
create table if not exists public.message_external_media (
    id               uuid primary key default gen_random_uuid(),
    message_id       bigint not null references public.messages(id) on delete cascade,
    provider         text not null check (provider = 'giphy'),
    external_id      text not null check (external_id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    media_type       text not null check (media_type = 'gif'),
    title            text check (char_length(title) <= 255),
    creator_username text check (char_length(creator_username) <= 100),
    page_url         text not null check (page_url ~ '^https://' and char_length(page_url) <= 2048),
    preview_url      text not null check (preview_url ~ '^https://' and char_length(preview_url) <= 2048),
    display_url      text not null check (display_url ~ '^https://' and char_length(display_url) <= 2048),
    mp4_url          text check (mp4_url is null or (mp4_url ~ '^https://' and char_length(mp4_url) <= 2048)),
    width            integer not null check (width > 0 and width <= 4096),
    height           integer not null check (height > 0 and height <= 4096),
    created_at       timestamptz not null default now(),
    constraint uq_message_external_media_message_id unique (message_id)
);

-- RLS & Grants: Chỉ service_role được thao tác
alter table public.message_external_media enable row level security;
revoke all on public.message_external_media from public, anon, authenticated;
grant all on public.message_external_media to service_role;

-- ----------------------------------------------------------------------------
-- 2. Drop signature cũ để tránh PostgREST ambiguous function overloads
-- ----------------------------------------------------------------------------
drop function if exists public.create_channel_message(uuid, uuid, text, uuid, bigint, jsonb, boolean);
drop function if exists public.create_channel_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb);

drop function if exists public.create_conversation_message(uuid, uuid, text, uuid, bigint, jsonb, boolean);
drop function if exists public.create_conversation_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb);

-- ----------------------------------------------------------------------------
-- 3. RPC: create_channel_message (Hỗ trợ cả text channel & voice channel chat)
-- ----------------------------------------------------------------------------
create or replace function public.create_channel_message(
    p_channel_id     uuid,
    p_author_id      uuid,
    p_content        text,
    p_client_nonce   uuid,
    p_reply_to_id    bigint default null,
    p_attachments    jsonb default '[]'::jsonb,
    p_is_forwarded   boolean default false,
    p_external_media jsonb default null
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
    v_ext_id           uuid;
    v_ext_provider     text;
    v_ext_external_id  text;
    v_ext_media_type   text;
    v_ext_title        text;
    v_ext_creator      text;
    v_ext_page_url     text;
    v_ext_preview_url  text;
    v_ext_display_url  text;
    v_ext_mp4_url      text;
    v_ext_width        integer;
    v_ext_height       integer;
    v_ext_created_at   timestamptz;
    v_media_result     jsonb := null;
begin
    -- 1. Kiểm tra tham số cơ bản
    if p_channel_id is null or p_author_id is null or p_client_nonce is null then
        raise exception 'Tham số channel_id, author_id và client_nonce là bắt buộc' using errcode = '22023';
    end if;

    if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
        raise exception 'Danh sách attachments phải là một JSON array hợp lệ' using errcode = '22023';
    end if;

    if p_external_media is not null and jsonb_typeof(p_external_media) <> 'object' then
        raise exception 'external_media phải là một JSON object hợp lệ' using errcode = '22023';
    end if;

    v_trimmed_content := p_content;
    if (v_trimmed_content is null or trim(v_trimmed_content) = '') 
       and jsonb_array_length(p_attachments) = 0 
       and p_external_media is null then
        raise exception 'Tin nhắn phải có nội dung văn bản, tệp đính kèm hoặc ảnh GIF' using errcode = '22023';
    end if;

    if v_trimmed_content is not null and char_length(v_trimmed_content) > 4000 then
        raise exception 'Nội dung tin nhắn không được vượt quá 4000 ký tự' using errcode = '22023';
    end if;

    -- 2. Kiểm tra tồn tại của channel (hỗ trợ cả kênh văn bản và kênh thoại)
    select id, server_id, type into v_chan
    from public.channels
    where id = p_channel_id;

    if not found then
        raise exception 'Kênh không tồn tại hoặc đã bị xóa' using errcode = 'P0002';
    end if;

    if v_chan.type <> 'text' and v_chan.type <> 'voice' then
        raise exception 'Loại kênh không hỗ trợ tin nhắn trò chuyện' using errcode = '22023';
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

    -- 4. Tính toán quyền hiệu dụng
    if p_author_id = v_server_owner_id or v_member_role = 'owner' then
        v_is_admin := true;
    else
        select id, permissions into v_everyone_role_id, v_base_perms
        from public.roles
        where server_id = v_chan.server_id and is_default = true;

        if (v_base_perms & (1::bigint << 62)) <> 0 then
            v_is_admin := true;
        else
            for v_roles_allow in
                select r.permissions
                from public.server_member_roles smr
                join public.roles r on r.id = smr.role_id
                where smr.server_id = v_chan.server_id and smr.user_id = p_author_id
            loop
                v_base_perms := v_base_perms | v_roles_allow;
                if (v_base_perms & (1::bigint << 62)) <> 0 then
                    v_is_admin := true;
                    exit;
                end if;
            end loop;
        end if;
    end if;

    if not v_is_admin then
        v_effective_perms := v_base_perms;

        if v_everyone_role_id is not null then
            select coalesce(allow_permissions, 0), coalesce(deny_permissions, 0)
            into v_ev_allow, v_ev_deny
            from public.channel_overwrites
            where channel_id = p_channel_id and target_type = 'role' and target_id = v_everyone_role_id;

            if found then
                v_effective_perms := (v_effective_perms & ~v_ev_deny) | v_ev_allow;
            end if;
        end if;

        v_roles_allow := 0;
        v_roles_deny := 0;
        select coalesce(bit_or(coalesce(co.allow_permissions, 0)), 0),
               coalesce(bit_or(coalesce(co.deny_permissions, 0)), 0)
        into v_roles_allow, v_roles_deny
        from public.server_member_roles smr
        join public.channel_overwrites co on co.channel_id = p_channel_id 
             and co.target_type = 'role' and co.target_id = smr.role_id
        where smr.server_id = v_chan.server_id and smr.user_id = p_author_id;

        v_effective_perms := (v_effective_perms & ~v_roles_deny) | v_roles_allow;

        select coalesce(allow_permissions, 0), coalesce(deny_permissions, 0)
        into v_mem_allow, v_mem_deny
        from public.channel_overwrites
        where channel_id = p_channel_id and target_type = 'member' and target_id = p_author_id;

        if found then
            v_effective_perms := (v_effective_perms & ~v_mem_deny) | v_mem_allow;
        end if;

        -- VIEW_CHANNEL = 1 (1 << 0)
        if (v_effective_perms & (1::bigint << 0)) = 0 then
            raise exception 'Bạn không có quyền xem kênh này' using errcode = '42501';
        end if;

        -- SEND_MESSAGES = 2 (1 << 1)
        if (v_effective_perms & (1::bigint << 1)) = 0 then
            raise exception 'Bạn không có quyền gửi tin nhắn trong kênh này' using errcode = '42501';
        end if;

        -- ATTACH_FILES = 8 (1 << 3)
        if jsonb_array_length(p_attachments) > 0 and (v_effective_perms & (1::bigint << 3)) = 0 then
            raise exception 'Bạn không có quyền đính kèm tệp trong kênh này' using errcode = '42501';
        end if;
    end if;

    -- 5. Kiểm tra reply_to_id
    if p_reply_to_id is not null then
        select channel_id into v_reply_chan_id
        from public.messages
        where id = p_reply_to_id;

        if not found then
            raise exception 'Tin nhắn được trả lời không tồn tại' using errcode = 'P0002';
        end if;

        if v_reply_chan_id <> p_channel_id then
            raise exception 'Tin nhắn được trả lời không thuộc kênh này' using errcode = '22023';
        end if;
    end if;

    -- 6. Kiểm tra Idempotency qua client_nonce
    select m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content, 
           m.is_forwarded, m.reply_to_id, m.client_nonce, m.edited_at, m.deleted_at, m.created_at
    into v_existing_msg
    from public.messages m
    where m.author_id = p_author_id and m.client_nonce = p_client_nonce;

    if found then
        if v_existing_msg.channel_id <> p_channel_id then
            raise exception 'Client nonce đã được sử dụng cho kênh khác' using errcode = '23505';
        end if;

        -- Tải attachments đã có
        select coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'id', a.id,
                    'filename', a.filename,
                    'mimeType', a.mime_type,
                    'sizeBytes', a.size_bytes,
                    'width', a.width,
                    'height', a.height,
                    'signedUrl', null,
                    'storagePath', a.storage_path
                ) order by a.created_at asc
            ),
            '[]'::jsonb
        ) into v_att_list
        from public.attachments a
        where a.message_id = v_existing_msg.id;

        -- Tải externalMedia đã có
        select jsonb_build_object(
            'provider', em.provider,
            'externalId', em.external_id,
            'mediaType', em.media_type,
            'title', coalesce(em.title, ''),
            'creatorUsername', em.creator_username,
            'pageUrl', em.page_url,
            'previewUrl', em.preview_url,
            'displayUrl', em.display_url,
            'mp4Url', em.mp4_url,
            'width', em.width,
            'height', em.height
        ) into v_media_result
        from public.message_external_media em
        where em.message_id = v_existing_msg.id;

        select id, username, display_name, avatar_url into v_author_rec
        from public.profiles
        where id = v_existing_msg.author_id;

        return jsonb_build_object(
            'id', v_existing_msg.id::text,
            'channelId', v_existing_msg.channel_id,
            'conversationId', null,
            'authorId', v_existing_msg.author_id,
            'author', case when v_author_rec.id is not null then
                jsonb_build_object(
                    'id', v_author_rec.id,
                    'username', v_author_rec.username,
                    'displayName', coalesce(v_author_rec.display_name, v_author_rec.username),
                    'avatarUrl', v_author_rec.avatar_url
                )
            else null end,
            'type', v_existing_msg.type,
            'content', case when v_existing_msg.deleted_at is not null then null else v_existing_msg.content end,
            'replyToId', case when v_existing_msg.reply_to_id is not null then v_existing_msg.reply_to_id::text else null end,
            'clientNonce', v_existing_msg.client_nonce,
            'editedAt', v_existing_msg.edited_at,
            'deletedAt', v_existing_msg.deleted_at,
            'isForwarded', coalesce(v_existing_msg.is_forwarded, false),
            'externalMedia', v_media_result,
            'attachments', v_att_list,
            'reactions', '[]'::jsonb,
            'createdAt', v_existing_msg.created_at
        );
    end if;

    -- 7. Validate attachments batch
    v_att_count := jsonb_array_length(p_attachments);
    if v_att_count > 5 then
        raise exception 'Chỉ được đính kèm tối đa 5 file mỗi tin nhắn' using errcode = '22023';
    end if;

    for v_att_elem in select * from jsonb_array_elements(p_attachments)
    loop
        v_att_size := (v_att_elem->>'sizeBytes')::bigint;
        if v_att_size is null or v_att_size <= 0 then
            raise exception 'Kích thước file không hợp lệ' using errcode = '22023';
        end if;
        if v_att_size > 10485760 then
            raise exception 'File vượt quá dung lượng tối đa 10MB' using errcode = '22023';
        end if;
        v_total_bytes := v_total_bytes + v_att_size;
    end loop;

    if v_total_bytes > 31457280 then
        raise exception 'Tổng dung lượng các file đính kèm không được vượt quá 30MB' using errcode = '22023';
    end if;

    -- 8. Validate external_media nếu có
    if p_external_media is not null then
        v_ext_provider    := p_external_media->>'provider';
        v_ext_external_id := p_external_media->>'externalId';
        v_ext_media_type  := p_external_media->>'mediaType';
        v_ext_title       := p_external_media->>'title';
        v_ext_creator     := p_external_media->>'creatorUsername';
        v_ext_page_url    := p_external_media->>'pageUrl';
        v_ext_preview_url := p_external_media->>'previewUrl';
        v_ext_display_url := p_external_media->>'displayUrl';
        v_ext_mp4_url     := p_external_media->>'mp4Url';
        v_ext_width       := (p_external_media->>'width')::integer;
        v_ext_height      := (p_external_media->>'height')::integer;

        if v_ext_provider <> 'giphy' or v_ext_media_type <> 'gif' or v_ext_external_id is null 
           or v_ext_page_url is null or v_ext_preview_url is null or v_ext_display_url is null
           or v_ext_width is null or v_ext_height is null or v_ext_width <= 0 or v_ext_height <= 0 then
            raise exception 'Dữ liệu external_media không hợp lệ' using errcode = '22023';
        end if;
    end if;

    -- 9. Ghi tin nhắn vào public.messages (với ON CONFLICT DO NOTHING trên partial unique index)
    insert into public.messages (
        channel_id,
        conversation_id,
        author_id,
        type,
        content,
        client_nonce,
        reply_to_id,
        is_forwarded
    ) values (
        p_channel_id,
        null,
        p_author_id,
        'default',
        case when v_trimmed_content is not null and trim(v_trimmed_content) <> '' then v_trimmed_content else null end,
        p_client_nonce,
        p_reply_to_id,
        coalesce(p_is_forwarded, false)
    )
    on conflict (author_id, client_nonce) where client_nonce is not null
    do nothing
    returning id, created_at into v_msg_id, v_created_at;

    -- Nếu v_msg_id is null, nghĩa là xảy ra race condition với concurrent transaction cùng nonce
    -- -> Load bản ghi canonical đã được tạo bởi transaction thắng cuộc và trả về trực tiếp
    if v_msg_id is null then
        select m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content, 
               m.is_forwarded, m.reply_to_id, m.client_nonce, m.edited_at, m.deleted_at, m.created_at
        into v_existing_msg
        from public.messages m
        where m.author_id = p_author_id and m.client_nonce = p_client_nonce;

        if not found then
            raise exception 'Lỗi xử lý idempotency cho client nonce' using errcode = '23505';
        end if;

        if v_existing_msg.channel_id <> p_channel_id then
            raise exception 'Client nonce đã được sử dụng cho kênh khác' using errcode = '23505';
        end if;

        -- Tải attachments đã có
        select coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'id', a.id,
                    'filename', a.filename,
                    'mimeType', a.mime_type,
                    'sizeBytes', a.size_bytes,
                    'width', a.width,
                    'height', a.height,
                    'signedUrl', null,
                    'storagePath', a.storage_path
                ) order by a.created_at asc
            ),
            '[]'::jsonb
        ) into v_att_list
        from public.attachments a
        where a.message_id = v_existing_msg.id;

        -- Tải externalMedia đã có
        select jsonb_build_object(
            'provider', em.provider,
            'externalId', em.external_id,
            'mediaType', em.media_type,
            'title', coalesce(em.title, ''),
            'creatorUsername', em.creator_username,
            'pageUrl', em.page_url,
            'previewUrl', em.preview_url,
            'displayUrl', em.display_url,
            'mp4Url', em.mp4_url,
            'width', em.width,
            'height', em.height
        ) into v_media_result
        from public.message_external_media em
        where em.message_id = v_existing_msg.id;

        select id, username, display_name, avatar_url into v_author_rec
        from public.profiles
        where id = v_existing_msg.author_id;

        return jsonb_build_object(
            'id', v_existing_msg.id::text,
            'channelId', v_existing_msg.channel_id,
            'conversationId', null,
            'authorId', v_existing_msg.author_id,
            'author', case when v_author_rec.id is not null then
                jsonb_build_object(
                    'id', v_author_rec.id,
                    'username', v_author_rec.username,
                    'displayName', coalesce(v_author_rec.display_name, v_author_rec.username),
                    'avatarUrl', v_author_rec.avatar_url
                )
            else null end,
            'type', v_existing_msg.type,
            'content', case when v_existing_msg.deleted_at is not null then null else v_existing_msg.content end,
            'replyToId', case when v_existing_msg.reply_to_id is not null then v_existing_msg.reply_to_id::text else null end,
            'clientNonce', v_existing_msg.client_nonce,
            'editedAt', v_existing_msg.edited_at,
            'deletedAt', v_existing_msg.deleted_at,
            'isForwarded', coalesce(v_existing_msg.is_forwarded, false),
            'externalMedia', v_media_result,
            'attachments', v_att_list,
            'reactions', '[]'::jsonb,
            'createdAt', v_existing_msg.created_at,
            'isDuplicate', true
        );
    end if;

    -- 10. Ghi attachments (nếu có)
    if v_att_count > 0 then
        for v_att_elem in select * from jsonb_array_elements(p_attachments)
        loop
            v_att_path     := v_att_elem->>'storagePath';
            v_att_filename := v_att_elem->>'filename';
            v_att_mime     := v_att_elem->>'mimeType';
            v_att_size     := (v_att_elem->>'sizeBytes')::bigint;
            v_att_width    := (v_att_elem->>'width')::integer;
            v_att_height   := (v_att_elem->>'height')::integer;

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
                'signedUrl', null,
                'storagePath', v_att_path
            );
        end loop;
    end if;

    -- 11. Ghi external_media (nếu có)
    if p_external_media is not null then
        insert into public.message_external_media (
            message_id,
            provider,
            external_id,
            media_type,
            title,
            creator_username,
            page_url,
            preview_url,
            display_url,
            mp4_url,
            width,
            height
        ) values (
            v_msg_id,
            v_ext_provider,
            v_ext_external_id,
            v_ext_media_type,
            v_ext_title,
            v_ext_creator,
            v_ext_page_url,
            v_ext_preview_url,
            v_ext_display_url,
            v_ext_mp4_url,
            v_ext_width,
            v_ext_height
        )
        returning id, created_at into v_ext_id, v_ext_created_at;

        v_media_result := jsonb_build_object(
            'provider', v_ext_provider,
            'externalId', v_ext_external_id,
            'mediaType', v_ext_media_type,
            'title', coalesce(v_ext_title, ''),
            'creatorUsername', v_ext_creator,
            'pageUrl', v_ext_page_url,
            'previewUrl', v_ext_preview_url,
            'displayUrl', v_ext_display_url,
            'mp4Url', v_ext_mp4_url,
            'width', v_ext_width,
            'height', v_ext_height
        );
    end if;

    -- 12. Trả về payload canonical đầy đủ
    select id, username, display_name, avatar_url into v_author_rec
    from public.profiles
    where id = p_author_id;

    return jsonb_build_object(
        'id', v_msg_id::text,
        'channelId', p_channel_id,
        'conversationId', null,
        'authorId', p_author_id,
        'author', case when v_author_rec.id is not null then
            jsonb_build_object(
                'id', v_author_rec.id,
                'username', v_author_rec.username,
                'displayName', coalesce(v_author_rec.display_name, v_author_rec.username),
                'avatarUrl', v_author_rec.avatar_url
            )
        else null end,
        'type', 'default',
        'content', case when v_trimmed_content is not null and trim(v_trimmed_content) <> '' then v_trimmed_content else null end,
        'replyToId', case when p_reply_to_id is not null then p_reply_to_id::text else null end,
        'clientNonce', p_client_nonce,
        'editedAt', null,
        'deletedAt', null,
        'isForwarded', coalesce(p_is_forwarded, false),
        'externalMedia', v_media_result,
        'attachments', v_att_list,
        'reactions', '[]'::jsonb,
        'createdAt', v_created_at
    );
end;
$$;

revoke all on function public.create_channel_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.create_channel_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- 4. RPC: create_conversation_message (Direct Messages / 1-1 / Group DM)
-- ----------------------------------------------------------------------------
create or replace function public.create_conversation_message(
    p_conversation_id uuid,
    p_author_id       uuid,
    p_content         text,
    p_client_nonce    uuid,
    p_reply_to_id     bigint default null,
    p_attachments     jsonb default '[]'::jsonb,
    p_is_forwarded    boolean default false,
    p_external_media  jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_is_member        boolean := false;
    v_reply_conv_id    uuid;
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
    v_ext_id           uuid;
    v_ext_provider     text;
    v_ext_external_id  text;
    v_ext_media_type   text;
    v_ext_title        text;
    v_ext_creator      text;
    v_ext_page_url     text;
    v_ext_preview_url  text;
    v_ext_display_url  text;
    v_ext_mp4_url      text;
    v_ext_width        integer;
    v_ext_height       integer;
    v_ext_created_at   timestamptz;
    v_media_result     jsonb := null;
begin
    -- 1. Kiểm tra tham số cơ bản
    if p_conversation_id is null or p_author_id is null or p_client_nonce is null then
        raise exception 'Tham số conversation_id, author_id và client_nonce là bắt buộc' using errcode = '22023';
    end if;

    if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
        raise exception 'Danh sách attachments phải là một JSON array hợp lệ' using errcode = '22023';
    end if;

    if p_external_media is not null and jsonb_typeof(p_external_media) <> 'object' then
        raise exception 'external_media phải là một JSON object hợp lệ' using errcode = '22023';
    end if;

    v_trimmed_content := p_content;
    if (v_trimmed_content is null or trim(v_trimmed_content) = '') 
       and jsonb_array_length(p_attachments) = 0 
       and p_external_media is null then
        raise exception 'Tin nhắn phải có nội dung văn bản, tệp đính kèm hoặc ảnh GIF' using errcode = '22023';
    end if;

    if v_trimmed_content is not null and char_length(v_trimmed_content) > 4000 then
        raise exception 'Nội dung tin nhắn không được vượt quá 4000 ký tự' using errcode = '22023';
    end if;

    -- 2. Kiểm tra membership trong cuộc trò chuyện
    select exists(
        select 1 from public.conversation_participants
        where conversation_id = p_conversation_id and user_id = p_author_id
    ) into v_is_member;

    if not v_is_member then
        raise exception 'Bạn không phải là thành viên của cuộc trò chuyện này' using errcode = '42501';
    end if;

    -- 3. Kiểm tra reply_to_id
    if p_reply_to_id is not null then
        select conversation_id into v_reply_conv_id
        from public.messages
        where id = p_reply_to_id;

        if not found then
            raise exception 'Tin nhắn được trả lời không tồn tại' using errcode = 'P0002';
        end if;

        if v_reply_conv_id <> p_conversation_id then
            raise exception 'Tin nhắn được trả lời không thuộc cuộc trò chuyện này' using errcode = '22023';
        end if;
    end if;

    -- 4. Kiểm tra Idempotency qua client_nonce
    select m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content, 
           m.is_forwarded, m.reply_to_id, m.client_nonce, m.edited_at, m.deleted_at, m.created_at
    into v_existing_msg
    from public.messages m
    where m.author_id = p_author_id and m.client_nonce = p_client_nonce;

    if found then
        if v_existing_msg.conversation_id <> p_conversation_id then
            raise exception 'Client nonce đã được sử dụng cho cuộc trò chuyện khác' using errcode = '23505';
        end if;

        -- Tải attachments đã có
        select coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'id', a.id,
                    'filename', a.filename,
                    'mimeType', a.mime_type,
                    'sizeBytes', a.size_bytes,
                    'width', a.width,
                    'height', a.height,
                    'signedUrl', null,
                    'storagePath', a.storage_path
                ) order by a.created_at asc
            ),
            '[]'::jsonb
        ) into v_att_list
        from public.attachments a
        where a.message_id = v_existing_msg.id;

        -- Tải externalMedia đã có
        select jsonb_build_object(
            'provider', em.provider,
            'externalId', em.external_id,
            'mediaType', em.media_type,
            'title', coalesce(em.title, ''),
            'creatorUsername', em.creator_username,
            'pageUrl', em.page_url,
            'previewUrl', em.preview_url,
            'displayUrl', em.display_url,
            'mp4Url', em.mp4_url,
            'width', em.width,
            'height', em.height
        ) into v_media_result
        from public.message_external_media em
        where em.message_id = v_existing_msg.id;

        select id, username, display_name, avatar_url into v_author_rec
        from public.profiles
        where id = v_existing_msg.author_id;

        return jsonb_build_object(
            'id', v_existing_msg.id::text,
            'channelId', null,
            'conversationId', v_existing_msg.conversation_id,
            'authorId', v_existing_msg.author_id,
            'author', case when v_author_rec.id is not null then
                jsonb_build_object(
                    'id', v_author_rec.id,
                    'username', v_author_rec.username,
                    'displayName', coalesce(v_author_rec.display_name, v_author_rec.username),
                    'avatarUrl', v_author_rec.avatar_url
                )
            else null end,
            'type', v_existing_msg.type,
            'content', case when v_existing_msg.deleted_at is not null then null else v_existing_msg.content end,
            'replyToId', case when v_existing_msg.reply_to_id is not null then v_existing_msg.reply_to_id::text else null end,
            'clientNonce', v_existing_msg.client_nonce,
            'editedAt', v_existing_msg.edited_at,
            'deletedAt', v_existing_msg.deleted_at,
            'isForwarded', coalesce(v_existing_msg.is_forwarded, false),
            'externalMedia', v_media_result,
            'attachments', v_att_list,
            'reactions', '[]'::jsonb,
            'createdAt', v_existing_msg.created_at
        );
    end if;

    -- 5. Validate attachments batch
    v_att_count := jsonb_array_length(p_attachments);
    if v_att_count > 5 then
        raise exception 'Chỉ được đính kèm tối đa 5 file mỗi tin nhắn' using errcode = '22023';
    end if;

    for v_att_elem in select * from jsonb_array_elements(p_attachments)
    loop
        v_att_size := (v_att_elem->>'sizeBytes')::bigint;
        if v_att_size is null or v_att_size <= 0 then
            raise exception 'Kích thước file không hợp lệ' using errcode = '22023';
        end if;
        if v_att_size > 10485760 then
            raise exception 'File vượt quá dung lượng tối đa 10MB' using errcode = '22023';
        end if;
        v_total_bytes := v_total_bytes + v_att_size;
    end loop;

    if v_total_bytes > 31457280 then
        raise exception 'Tổng dung lượng các file đính kèm không được vượt quá 30MB' using errcode = '22023';
    end if;

    -- 6. Validate external_media nếu có
    if p_external_media is not null then
        v_ext_provider    := p_external_media->>'provider';
        v_ext_external_id := p_external_media->>'externalId';
        v_ext_media_type  := p_external_media->>'mediaType';
        v_ext_title       := p_external_media->>'title';
        v_ext_creator     := p_external_media->>'creatorUsername';
        v_ext_page_url    := p_external_media->>'pageUrl';
        v_ext_preview_url := p_external_media->>'previewUrl';
        v_ext_display_url := p_external_media->>'displayUrl';
        v_ext_mp4_url     := p_external_media->>'mp4Url';
        v_ext_width       := (p_external_media->>'width')::integer;
        v_ext_height      := (p_external_media->>'height')::integer;

        if v_ext_provider <> 'giphy' or v_ext_media_type <> 'gif' or v_ext_external_id is null 
           or v_ext_page_url is null or v_ext_preview_url is null or v_ext_display_url is null
           or v_ext_width is null or v_ext_height is null or v_ext_width <= 0 or v_ext_height <= 0 then
            raise exception 'Dữ liệu external_media không hợp lệ' using errcode = '22023';
        end if;
    end if;

    -- 7. Ghi tin nhắn vào public.messages (với ON CONFLICT DO NOTHING trên partial unique index)
    insert into public.messages (
        channel_id,
        conversation_id,
        author_id,
        type,
        content,
        client_nonce,
        reply_to_id,
        is_forwarded
    ) values (
        null,
        p_conversation_id,
        p_author_id,
        'default',
        case when v_trimmed_content is not null and trim(v_trimmed_content) <> '' then v_trimmed_content else null end,
        p_client_nonce,
        p_reply_to_id,
        coalesce(p_is_forwarded, false)
    )
    on conflict (author_id, client_nonce) where client_nonce is not null
    do nothing
    returning id, created_at into v_msg_id, v_created_at;

    -- Nếu v_msg_id is null, nghĩa là xảy ra race condition với concurrent transaction cùng nonce
    -- -> Load bản ghi canonical đã được tạo bởi transaction thắng cuộc và trả về trực tiếp
    if v_msg_id is null then
        select m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content, 
               m.is_forwarded, m.reply_to_id, m.client_nonce, m.edited_at, m.deleted_at, m.created_at
        into v_existing_msg
        from public.messages m
        where m.author_id = p_author_id and m.client_nonce = p_client_nonce;

        if not found then
            raise exception 'Lỗi xử lý idempotency cho client nonce' using errcode = '23505';
        end if;

        if v_existing_msg.conversation_id <> p_conversation_id then
            raise exception 'Client nonce đã được sử dụng cho cuộc trò chuyện khác' using errcode = '23505';
        end if;

        -- Tải attachments đã có
        select coalesce(
            jsonb_agg(
                jsonb_build_object(
                    'id', a.id,
                    'filename', a.filename,
                    'mimeType', a.mime_type,
                    'sizeBytes', a.size_bytes,
                    'width', a.width,
                    'height', a.height,
                    'signedUrl', null,
                    'storagePath', a.storage_path
                ) order by a.created_at asc
            ),
            '[]'::jsonb
        ) into v_att_list
        from public.attachments a
        where a.message_id = v_existing_msg.id;

        -- Tải externalMedia đã có
        select jsonb_build_object(
            'provider', em.provider,
            'externalId', em.external_id,
            'mediaType', em.media_type,
            'title', coalesce(em.title, ''),
            'creatorUsername', em.creator_username,
            'pageUrl', em.page_url,
            'previewUrl', em.preview_url,
            'displayUrl', em.display_url,
            'mp4Url', em.mp4_url,
            'width', em.width,
            'height', em.height
        ) into v_media_result
        from public.message_external_media em
        where em.message_id = v_existing_msg.id;

        select id, username, display_name, avatar_url into v_author_rec
        from public.profiles
        where id = v_existing_msg.author_id;

        return jsonb_build_object(
            'id', v_existing_msg.id::text,
            'channelId', null,
            'conversationId', v_existing_msg.conversation_id,
            'authorId', v_existing_msg.author_id,
            'author', case when v_author_rec.id is not null then
                jsonb_build_object(
                    'id', v_author_rec.id,
                    'username', v_author_rec.username,
                    'displayName', coalesce(v_author_rec.display_name, v_author_rec.username),
                    'avatarUrl', v_author_rec.avatar_url
                )
            else null end,
            'type', v_existing_msg.type,
            'content', case when v_existing_msg.deleted_at is not null then null else v_existing_msg.content end,
            'replyToId', case when v_existing_msg.reply_to_id is not null then v_existing_msg.reply_to_id::text else null end,
            'clientNonce', v_existing_msg.client_nonce,
            'editedAt', v_existing_msg.edited_at,
            'deletedAt', v_existing_msg.deleted_at,
            'isForwarded', coalesce(v_existing_msg.is_forwarded, false),
            'externalMedia', v_media_result,
            'attachments', v_att_list,
            'reactions', '[]'::jsonb,
            'createdAt', v_existing_msg.created_at,
            'isDuplicate', true
        );
    end if;

    -- 8. Ghi attachments (nếu có)
    if v_att_count > 0 then
        for v_att_elem in select * from jsonb_array_elements(p_attachments)
        loop
            v_att_path     := v_att_elem->>'storagePath';
            v_att_filename := v_att_elem->>'filename';
            v_att_mime     := v_att_elem->>'mimeType';
            v_att_size     := (v_att_elem->>'sizeBytes')::bigint;
            v_att_width    := (v_att_elem->>'width')::integer;
            v_att_height   := (v_att_elem->>'height')::integer;

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
                'signedUrl', null,
                'storagePath', v_att_path
            );
        end loop;
    end if;

    -- 9. Ghi external_media (nếu có)
    if p_external_media is not null then
        insert into public.message_external_media (
            message_id,
            provider,
            external_id,
            media_type,
            title,
            creator_username,
            page_url,
            preview_url,
            display_url,
            mp4_url,
            width,
            height
        ) values (
            v_msg_id,
            v_ext_provider,
            v_ext_external_id,
            v_ext_media_type,
            v_ext_title,
            v_ext_creator,
            v_ext_page_url,
            v_ext_preview_url,
            v_ext_display_url,
            v_ext_mp4_url,
            v_ext_width,
            v_ext_height
        )
        returning id, created_at into v_ext_id, v_ext_created_at;

        v_media_result := jsonb_build_object(
            'provider', v_ext_provider,
            'externalId', v_ext_external_id,
            'mediaType', v_ext_media_type,
            'title', coalesce(v_ext_title, ''),
            'creatorUsername', v_ext_creator,
            'pageUrl', v_ext_page_url,
            'previewUrl', v_ext_preview_url,
            'displayUrl', v_ext_display_url,
            'mp4Url', v_ext_mp4_url,
            'width', v_ext_width,
            'height', v_ext_height
        );
    end if;

    -- 10. Trả về payload canonical đầy đủ
    select id, username, display_name, avatar_url into v_author_rec
    from public.profiles
    where id = p_author_id;

    return jsonb_build_object(
        'id', v_msg_id::text,
        'channelId', null,
        'conversationId', p_conversation_id,
        'authorId', p_author_id,
        'author', case when v_author_rec.id is not null then
            jsonb_build_object(
                'id', v_author_rec.id,
                'username', v_author_rec.username,
                'displayName', coalesce(v_author_rec.display_name, v_author_rec.username),
                'avatarUrl', v_author_rec.avatar_url
            )
        else null end,
        'type', 'default',
        'content', case when v_trimmed_content is not null and trim(v_trimmed_content) <> '' then v_trimmed_content else null end,
        'replyToId', case when p_reply_to_id is not null then p_reply_to_id::text else null end,
        'clientNonce', p_client_nonce,
        'editedAt', null,
        'deletedAt', null,
        'isForwarded', coalesce(p_is_forwarded, false),
        'externalMedia', v_media_result,
        'attachments', v_att_list,
        'reactions', '[]'::jsonb,
        'createdAt', v_created_at
    );
end;
$$;

revoke all on function public.create_conversation_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.create_conversation_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb) to service_role;
