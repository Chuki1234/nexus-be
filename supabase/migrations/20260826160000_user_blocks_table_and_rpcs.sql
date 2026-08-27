-- ============================================================================
-- Migration: 20260826160000_user_blocks_table_and_rpcs.sql
-- Checkpoint: Canonical Persistent User Blocking, Security & Concurrency Invariants
-- ============================================================================

-- 0. Preflight Check: Dừng và báo lỗi ngay nếu có dữ liệu legacy friendships.status = 'blocked'
do $$
begin
  if exists (select 1 from public.friendships where status = 'blocked') then
    raise exception 'Migration preflight check failed: Found legacy friendships with status=blocked. Please resolve legacy data before applying.'
      using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. BẢNG USER_BLOCKS
-- ---------------------------------------------------------------------------
create table if not exists public.user_blocks (
    blocker_id      uuid not null references public.profiles(id) on delete cascade,
    blocked_user_id uuid not null references public.profiles(id) on delete cascade,
    created_at      timestamptz not null default clock_timestamp(),

    primary key (blocker_id, blocked_user_id),
    constraint user_blocks_not_self check (blocker_id <> blocked_user_id)
);

create index if not exists idx_user_blocks_blocked on public.user_blocks(blocked_user_id);
create index if not exists idx_user_blocks_created on public.user_blocks(blocker_id, created_at desc);

-- Phân quyền & RLS
alter table public.user_blocks enable row level security;
revoke all on table public.user_blocks from public, anon, authenticated;
grant all on table public.user_blocks to service_role;

drop policy if exists "service_role_user_blocks" on public.user_blocks;
create policy "service_role_user_blocks" on public.user_blocks for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 2. TRIGGER KIỂM TRA BLOCK TRÊN FRIENDSHIPS (Với Ordered Advisory Lock)
-- ---------------------------------------------------------------------------
create or replace function public.check_friendship_not_blocked()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_u1 uuid;
    v_u2 uuid;
begin
    v_u1 := least(NEW.user_a_id, NEW.user_b_id);
    v_u2 := greatest(NEW.user_a_id, NEW.user_b_id);

    perform pg_advisory_xact_lock(hashtext(v_u1::text));
    perform pg_advisory_xact_lock(hashtext(v_u2::text));

    if exists (
        select 1 from public.user_blocks
        where (blocker_id = v_u1 and blocked_user_id = v_u2)
           or (blocker_id = v_u2 and blocked_user_id = v_u1)
    ) then
        raise exception 'Không thể kết bạn do người dùng đã bị chặn.' using errcode = '42501';
    end if;

    return NEW;
end;
$$;

drop trigger if exists trg_check_friendship_user_blocks on public.friendships;
create trigger trg_check_friendship_user_blocks
before insert or update on public.friendships
for each row execute function public.check_friendship_not_blocked();

-- ---------------------------------------------------------------------------
-- 3. RPC: block_user (Nguyên tử: Advisory Lock, Clean friendships, Teardown calls)
-- ---------------------------------------------------------------------------
create or replace function public.block_user(
    p_blocker_id      uuid,
    p_blocked_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_u1 uuid;
    v_u2 uuid;
    v_blocked_profile record;
    v_terminated_call record;
    v_terminated_call_ids uuid[] := array[]::uuid[];
    v_blocked_at timestamptz;
begin
    -- 1. Kiểm tra tham số cơ bản & từ chối tự chặn
    if p_blocker_id is null or p_blocked_user_id is null then
        raise exception 'Tham số blocker_id và blocked_user_id là bắt buộc' using errcode = '22023';
    end if;

    if p_blocker_id = p_blocked_user_id then
        raise exception 'Không thể tự chặn chính mình' using errcode = '22023';
    end if;

    -- 2. Kiểm tra 2 user có tồn tại trong profiles
    if not exists (select 1 from public.profiles where id = p_blocker_id) then
        raise exception 'Người dùng thực hiện chặn không tồn tại' using errcode = 'P0002';
    end if;

    select id, username, display_name, avatar_url into v_blocked_profile
    from public.profiles
    where id = p_blocked_user_id;

    if not found then
        raise exception 'Người dùng bị chặn không tồn tại' using errcode = 'P0002';
    end if;

    -- 3. Khóa Advisory Lock theo thứ tự nhất quán chống deadlock
    v_u1 := least(p_blocker_id, p_blocked_user_id);
    v_u2 := greatest(p_blocker_id, p_blocked_user_id);

    perform pg_advisory_xact_lock(hashtext(v_u1::text));
    perform pg_advisory_xact_lock(hashtext(v_u2::text));

    -- 4. Ghi quan hệ chặn vào user_blocks (Idempotent: ON CONFLICT DO NOTHING)
    insert into public.user_blocks (blocker_id, blocked_user_id, created_at)
    values (p_blocker_id, p_blocked_user_id, clock_timestamp())
    on conflict (blocker_id, blocked_user_id) do update
      set created_at = public.user_blocks.created_at
    returning created_at into v_blocked_at;

    if v_blocked_at is null then
        select created_at into v_blocked_at
        from public.user_blocks
        where blocker_id = p_blocker_id and blocked_user_id = p_blocked_user_id;
    end if;

    -- 5. Xóa quan hệ bạn bè / lời mời kết bạn giữa 2 user
    delete from public.friendships
    where user_a_id = v_u1 and user_b_id = v_u2;

    -- 6. Dọn dẹp triệt để các cuộc gọi Direct Call đang active / ringing giữa 2 bên
    for v_terminated_call in
        select id, livekit_room_name
        from public.direct_calls
        where ((caller_id = p_blocker_id and callee_id = p_blocked_user_id) or
               (caller_id = p_blocked_user_id and callee_id = p_blocker_id))
          and status in ('ringing', 'accepted')
    loop
        -- Cập nhật call sang terminal state
        update public.direct_calls
        set status = 'ended',
            ended_at = clock_timestamp(),
            ended_by = p_blocker_id,
            end_reason = 'blocked_or_unfriended',
            version = version + 1,
            updated_at = clock_timestamp()
        where id = v_terminated_call.id;

        -- Xóa active user claim
        delete from public.direct_call_active_users
        where call_id = v_terminated_call.id;

        -- Enqueue outbox dọn dẹp LiveKit room
        insert into public.direct_call_room_cleanup_outbox (call_id, room_name, status)
        values (v_terminated_call.id, v_terminated_call.livekit_room_name, 'pending');

        v_terminated_call_ids := array_append(v_terminated_call_ids, v_terminated_call.id);
    end loop;

    return jsonb_build_object(
        'blocked_user', jsonb_build_object(
            'id', v_blocked_profile.id,
            'username', v_blocked_profile.username,
            'displayName', coalesce(v_blocked_profile.display_name, v_blocked_profile.username),
            'avatarUrl', v_blocked_profile.avatar_url,
            'blockedAt', v_blocked_at
        ),
        'terminated_call_ids', to_jsonb(v_terminated_call_ids)
    );
end;
$$;

revoke all on function public.block_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.block_user(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. RPC: unblock_user (Bỏ chặn nguyên tử)
-- ---------------------------------------------------------------------------
create or replace function public.unblock_user(
    p_blocker_id      uuid,
    p_blocked_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_u1 uuid;
    v_u2 uuid;
begin
    if p_blocker_id is null or p_blocked_user_id is null then
        raise exception 'Tham số blocker_id và blocked_user_id là bắt buộc' using errcode = '22023';
    end if;

    v_u1 := least(p_blocker_id, p_blocked_user_id);
    v_u2 := greatest(p_blocker_id, p_blocked_user_id);

    perform pg_advisory_xact_lock(hashtext(v_u1::text));
    perform pg_advisory_xact_lock(hashtext(v_u2::text));

    delete from public.user_blocks
    where blocker_id = p_blocker_id and blocked_user_id = p_blocked_user_id;
end;
$$;

revoke all on function public.unblock_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.unblock_user(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RPC: list_blocked_users
-- ---------------------------------------------------------------------------
create or replace function public.list_blocked_users(
    p_user_id uuid
)
returns table (
    id           uuid,
    username     text,
    display_name text,
    avatar_url   text,
    blocked_at   timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    if p_user_id is null then
        raise exception 'Tham số user_id là bắt buộc' using errcode = '22023';
    end if;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        p.avatar_url,
        ub.created_at as blocked_at
    from public.user_blocks ub
    join public.profiles p on p.id = ub.blocked_user_id
    where ub.blocker_id = p_user_id
    order by ub.created_at desc;
end;
$$;

revoke all on function public.list_blocked_users(uuid) from public, anon, authenticated;
grant execute on function public.list_blocked_users(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. REDEFINE RPC: create_conversation_message (Kiểm tra user_blocks cho DM)
-- ---------------------------------------------------------------------------
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
    v_conv_type        public.conversation_type;
    v_is_member        boolean := false;
    v_recipient_id     uuid;
    v_u1               uuid;
    v_u2               uuid;
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

    -- 2. Kiểm tra thông tin conversation & membership
    select type into v_conv_type
    from public.conversations
    where id = p_conversation_id;

    if not found then
        raise exception 'Cuộc trò chuyện không tồn tại' using errcode = 'P0002';
    end if;

    select exists(
        select 1 from public.conversation_participants
        where conversation_id = p_conversation_id and user_id = p_author_id
    ) into v_is_member;

    if not v_is_member then
        raise exception 'Bạn không phải là thành viên của cuộc trò chuyện này' using errcode = '42501';
    end if;

    -- 2.b Kiểm tra quan hệ chặn (Áp dụng cho cuộc trò chuyện 1-1 / dm)
    if v_conv_type = 'dm' then
        select user_id into v_recipient_id
        from public.conversation_participants
        where conversation_id = p_conversation_id and user_id <> p_author_id
        limit 1;

        if v_recipient_id is not null then
            v_u1 := least(p_author_id, v_recipient_id);
            v_u2 := greatest(p_author_id, v_recipient_id);

            perform pg_advisory_xact_lock(hashtext(v_u1::text));
            perform pg_advisory_xact_lock(hashtext(v_u2::text));

            if exists (
                select 1 from public.user_blocks
                where (blocker_id = v_u1 and blocked_user_id = v_u2)
                   or (blocker_id = v_u2 and blocked_user_id = v_u1)
            ) then
                raise exception 'Không thể gửi tin nhắn do người dùng đã bị chặn.' using errcode = '42501';
            end if;
        end if;
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
            'createdAt', v_existing_msg.created_at,
            'isDuplicate', true
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

    -- 7. Ghi tin nhắn vào public.messages
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

    -- 10. Lấy thông tin tác giả để populate
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
        'createdAt', v_created_at,
        'isDuplicate', false
    );
end;
$$;

revoke all on function public.create_conversation_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.create_conversation_message(uuid, uuid, text, uuid, bigint, jsonb, boolean, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. REDEFINE RPC: start_direct_call (Kiểm tra user_blocks 2 chiều)
-- ---------------------------------------------------------------------------
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

  -- C. Xác định thứ tự khóa advisory xact lock để chống deadlock
  if p_caller_id < v_callee_id then
    v_u1 := p_caller_id;
    v_u2 := v_callee_id;
  else
    v_u1 := v_callee_id;
    v_u2 := p_caller_id;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_u1::text));
  perform pg_advisory_xact_lock(hashtext(v_u2::text));

  -- D. Kiểm tra quan hệ chặn (user_blocks theo 2 chiều)
  if exists (
    select 1 from public.user_blocks
    where (blocker_id = v_u1 and blocked_user_id = v_u2)
       or (blocker_id = v_u2 and blocked_user_id = v_u1)
  ) then
    raise exception 'Không thể thực hiện cuộc gọi do có quan hệ chặn.'
      using errcode = '42501';
  end if;

  -- D.2 Kiểm tra quan hệ bạn bè hợp lệ (friendships.status = 'accepted')
  select status into v_friendship
  from public.friendships
  where (user_a_id = v_u1 and user_b_id = v_u2);

  if not found or v_friendship.status <> 'accepted' then
    raise exception 'Chỉ có thể gọi điện với người dùng đã kết bạn.'
      using errcode = '42501';
  end if;

  -- E. Kiểm tra bận (Active User Claim)
  if exists (
    select 1 from public.direct_call_active_users
    where user_id in (p_caller_id, v_callee_id)
  ) then
    raise exception 'BUSY: Người dùng hiện đang trong một cuộc gọi khác.'
      using errcode = '23505';
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
  )
  returning * into v_call;

  -- H. Claim Active Users cho cả Caller và Callee
  insert into public.direct_call_active_users (user_id, call_id, claimed_at)
  values
    (p_caller_id, v_call_id, clock_timestamp()),
    (v_callee_id, v_call_id, clock_timestamp());

  return next v_call;
end;
$$;

revoke all on function public.start_direct_call(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.start_direct_call(uuid, uuid, uuid, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC: get_or_create_dm_conversation
-- (Ordered Advisory Lock, 2-Way Block Check, Idempotent DM Creation & Participant Guarantee)
-- ---------------------------------------------------------------------------
create or replace function public.get_or_create_dm_conversation(
    p_user_id      uuid,
    p_recipient_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_u1 uuid;
    v_u2 uuid;
    v_dm_key text;
    v_conv record;
begin
    -- 1. Kiểm tra tham số & tự nhắn tin
    if p_user_id is null or p_recipient_id is null then
        raise exception 'Tham số user_id và recipient_id là bắt buộc' using errcode = '22023';
    end if;

    if p_user_id = p_recipient_id then
        raise exception 'Không thể tạo cuộc trò chuyện trực tiếp với chính mình' using errcode = '22023';
    end if;

    -- 2. Ordered Advisory Lock
    v_u1 := least(p_user_id, p_recipient_id);
    v_u2 := greatest(p_user_id, p_recipient_id);

    perform pg_advisory_xact_lock(hashtext(v_u1::text));
    perform pg_advisory_xact_lock(hashtext(v_u2::text));

    -- 3. Kiểm tra người nhận tồn tại
    if not exists (select 1 from public.profiles where id = p_recipient_id) then
        raise exception 'Không tìm thấy người dùng nhận.' using errcode = 'P0002';
    end if;

    -- 4. Kiểm tra quan hệ chặn 2 chiều trong user_blocks
    if exists (
        select 1 from public.user_blocks
        where (blocker_id = v_u1 and blocked_user_id = v_u2)
           or (blocker_id = v_u2 and blocked_user_id = v_u1)
    ) then
        raise exception 'Không thể nhắn tin trực tiếp với người dùng này do có quan hệ chặn.' using errcode = '42501';
    end if;

    -- 5. Tìm hoặc tạo conversation theo dm_key
    v_dm_key := v_u1::text || ':' || v_u2::text;

    select id, type, name, icon_url, owner_id, dm_key, created_at
    into v_conv
    from public.conversations
    where dm_key = v_dm_key;

    if not found then
        insert into public.conversations (type, dm_key, owner_id)
        values ('dm', v_dm_key, p_user_id)
        returning id, type, name, icon_url, owner_id, dm_key, created_at
        into v_conv;
    end if;

    -- 5. Đảm bảo 2 participant luôn tồn tại
    insert into public.conversation_participants (conversation_id, user_id)
    values (v_conv.id, v_u1), (v_conv.id, v_u2)
    on conflict (conversation_id, user_id) do nothing;

    return jsonb_build_object(
        'id', v_conv.id,
        'type', v_conv.type,
        'name', v_conv.name,
        'icon_url', v_conv.icon_url,
        'owner_id', v_conv.owner_id,
        'dm_key', v_conv.dm_key,
        'created_at', v_conv.created_at
    );
end;
$$;

revoke all on function public.get_or_create_dm_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_or_create_dm_conversation(uuid, uuid) to service_role;
