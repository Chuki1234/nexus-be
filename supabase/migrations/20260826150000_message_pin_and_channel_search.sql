-- ============================================================================
-- Ghim tin nhắn (pin) + Tìm kiếm tin nhắn trong phạm vi một kênh
--
-- 1. messages.pinned_at / pinned_by: đánh dấu tin được ghim + ai ghim.
-- 2. RPC search_channel_messages: tìm theo nội dung tin HOẶC tên file đính kèm,
--    chỉ trong 1 kênh, cursor theo id desc.
-- 3. RPC set_channel_message_pin: ghim/bỏ ghim (mọi thành viên server đều ghim
--    được — kiểm tra membership trong RPC).
-- 4. RPC get_channel_pinned_messages: danh sách tin đã ghim của kênh.
--
-- Membership/quyền xem kênh do NestJS Guard lo (giống get_channel_messages_paged);
-- RPC ghim vẫn tự kiểm membership vì là thao tác ghi.
-- ============================================================================

-- 1) Cột pin ----------------------------------------------------------------
alter table public.messages
    add column if not exists pinned_at timestamptz;

alter table public.messages
    add column if not exists pinned_by uuid references public.profiles(id) on delete set null;

create index if not exists idx_messages_channel_pinned
    on public.messages (channel_id, pinned_at desc)
    where pinned_at is not null;

-- 2) Tìm kiếm trong kênh ----------------------------------------------------
create or replace function public.search_channel_messages(
    p_channel_id uuid,
    p_user_id    uuid,
    p_query      text,
    p_limit      int default 30,
    p_before     bigint default null
)
returns table (
    id               bigint,
    channel_id       uuid,
    conversation_id  uuid,
    author_id        uuid,
    type             public.message_type,
    content          text,
    reply_to_id      bigint,
    sticker_provider text,
    sticker_id       text,
    sticker_url      text,
    client_nonce     uuid,
    is_forwarded     boolean,
    pinned_at        timestamptz,
    pinned_by        uuid,
    edited_at        timestamptz,
    deleted_at       timestamptz,
    created_at       timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
    select
        m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content,
        m.reply_to_id, m.sticker_provider, m.sticker_id, m.sticker_url,
        m.client_nonce, coalesce(m.is_forwarded, false) as is_forwarded,
        m.pinned_at, m.pinned_by, m.edited_at, m.deleted_at, m.created_at
    from public.messages m
    where m.channel_id = p_channel_id
      and m.deleted_at is null
      and (p_before is null or m.id < p_before)
      and not exists (
          select 1 from public.message_hidden_users h
          where h.user_id = p_user_id and h.message_id = m.id
      )
      and (
          m.content ilike '%' || p_query || '%'
          or exists (
              select 1 from public.attachments a
              where a.message_id = m.id and a.filename ilike '%' || p_query || '%'
          )
      )
    order by m.id desc
    limit p_limit + 1;
$$;

revoke all on function public.search_channel_messages(uuid, uuid, text, int, bigint) from public, anon, authenticated;
grant execute on function public.search_channel_messages(uuid, uuid, text, int, bigint) to service_role;

-- 3) Danh sách tin đã ghim --------------------------------------------------
create or replace function public.get_channel_pinned_messages(
    p_channel_id uuid,
    p_user_id    uuid
)
returns table (
    id               bigint,
    channel_id       uuid,
    conversation_id  uuid,
    author_id        uuid,
    type             public.message_type,
    content          text,
    reply_to_id      bigint,
    sticker_provider text,
    sticker_id       text,
    sticker_url      text,
    client_nonce     uuid,
    is_forwarded     boolean,
    pinned_at        timestamptz,
    pinned_by        uuid,
    edited_at        timestamptz,
    deleted_at       timestamptz,
    created_at       timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
    select
        m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content,
        m.reply_to_id, m.sticker_provider, m.sticker_id, m.sticker_url,
        m.client_nonce, coalesce(m.is_forwarded, false) as is_forwarded,
        m.pinned_at, m.pinned_by, m.edited_at, m.deleted_at, m.created_at
    from public.messages m
    where m.channel_id = p_channel_id
      and m.pinned_at is not null
      and m.deleted_at is null
      and not exists (
          select 1 from public.message_hidden_users h
          where h.user_id = p_user_id and h.message_id = m.id
      )
    order by m.pinned_at desc
    limit 100;
$$;

revoke all on function public.get_channel_pinned_messages(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_channel_pinned_messages(uuid, uuid) to service_role;

-- 4) Ghim / bỏ ghim ---------------------------------------------------------
create or replace function public.set_channel_message_pin(
    p_message_id bigint,
    p_user_id    uuid,
    p_pinned     boolean
)
returns table (
    id               bigint,
    channel_id       uuid,
    conversation_id  uuid,
    author_id        uuid,
    type             public.message_type,
    content          text,
    reply_to_id      bigint,
    sticker_provider text,
    sticker_id       text,
    sticker_url      text,
    client_nonce     uuid,
    is_forwarded     boolean,
    pinned_at        timestamptz,
    pinned_by        uuid,
    edited_at        timestamptz,
    deleted_at       timestamptz,
    created_at       timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_channel_id uuid;
    v_server_id  uuid;
begin
    -- Tin phải tồn tại, thuộc một kênh, chưa bị xoá
    select m.channel_id into v_channel_id
    from public.messages m
    where m.id = p_message_id and m.deleted_at is null;

    if v_channel_id is null then
        raise exception 'Tin nhắn không tồn tại hoặc không thuộc kênh nào' using errcode = 'P0002';
    end if;

    -- Kênh -> server
    select c.server_id into v_server_id
    from public.channels c
    where c.id = v_channel_id;

    if v_server_id is null then
        raise exception 'Kênh không thuộc máy chủ hợp lệ' using errcode = 'P0002';
    end if;

    -- Mọi thành viên server đều được ghim — nhưng phải là thành viên
    if not exists (
        select 1 from public.server_members sm
        where sm.server_id = v_server_id and sm.user_id = p_user_id
    ) then
        raise exception 'Bạn không phải là thành viên của máy chủ này' using errcode = '42501';
    end if;

    update public.messages m
    set pinned_at = case when p_pinned then now() else null end,
        pinned_by = case when p_pinned then p_user_id else null end
    where m.id = p_message_id;

    return query
    select
        m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content,
        m.reply_to_id, m.sticker_provider, m.sticker_id, m.sticker_url,
        m.client_nonce, coalesce(m.is_forwarded, false) as is_forwarded,
        m.pinned_at, m.pinned_by, m.edited_at, m.deleted_at, m.created_at
    from public.messages m
    where m.id = p_message_id;
end;
$$;

revoke all on function public.set_channel_message_pin(bigint, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_channel_message_pin(bigint, uuid, boolean) to service_role;
