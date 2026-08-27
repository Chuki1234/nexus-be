-- ============================================================================
-- Canonical message pins for direct conversations and server channels.
--
-- This migration is deliberately self-contained because the earlier local
-- channel-only pin migration has not been applied to the linked database.
-- It can therefore be applied independently without running unrelated files.
-- ============================================================================

alter table public.messages
    add column if not exists pinned_at timestamptz;

alter table public.messages
    add column if not exists pinned_by uuid references public.profiles(id) on delete set null;

create index if not exists idx_messages_conversation_pinned
    on public.messages (conversation_id, pinned_at desc)
    where conversation_id is not null and pinned_at is not null;

create index if not exists idx_messages_channel_pinned
    on public.messages (channel_id, pinned_at desc)
    where channel_id is not null and pinned_at is not null;

create or replace function public.get_conversation_pinned_messages(
    p_conversation_id uuid,
    p_user_id         uuid
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
begin
    if not exists (
        select 1
        from public.conversation_participants cp
        where cp.conversation_id = p_conversation_id
          and cp.user_id = p_user_id
    ) then
        raise exception 'User is not a participant of this conversation'
            using errcode = '42501';
    end if;

    return query
    select
        m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content,
        m.reply_to_id, m.sticker_provider, m.sticker_id, m.sticker_url,
        m.client_nonce, coalesce(m.is_forwarded, false),
        m.pinned_at, m.pinned_by, m.edited_at, m.deleted_at, m.created_at
    from public.messages m
    where m.conversation_id = p_conversation_id
      and m.pinned_at is not null
      and m.deleted_at is null
      and not exists (
          select 1
          from public.message_hidden_users h
          where h.user_id = p_user_id and h.message_id = m.id
      )
    order by m.pinned_at desc
    limit 100;
end;
$$;

revoke all on function public.get_conversation_pinned_messages(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.get_conversation_pinned_messages(uuid, uuid)
    to service_role;

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
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_server_id uuid;
begin
    select c.server_id into v_server_id
    from public.channels c
    where c.id = p_channel_id;

    if v_server_id is null or not exists (
        select 1
        from public.server_members sm
        where sm.server_id = v_server_id
          and sm.user_id = p_user_id
    ) then
        raise exception 'User cannot view this channel' using errcode = '42501';
    end if;

    return query
    select
        m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content,
        m.reply_to_id, m.sticker_provider, m.sticker_id, m.sticker_url,
        m.client_nonce, coalesce(m.is_forwarded, false),
        m.pinned_at, m.pinned_by, m.edited_at, m.deleted_at, m.created_at
    from public.messages m
    where m.channel_id = p_channel_id
      and m.pinned_at is not null
      and m.deleted_at is null
      and not exists (
          select 1
          from public.message_hidden_users h
          where h.user_id = p_user_id and h.message_id = m.id
      )
    order by m.pinned_at desc
    limit 100;
end;
$$;

revoke all on function public.get_channel_pinned_messages(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.get_channel_pinned_messages(uuid, uuid)
    to service_role;

create or replace function public.set_message_pin(
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
    v_channel_id      uuid;
    v_conversation_id uuid;
    v_server_id       uuid;
begin
    select m.channel_id, m.conversation_id
      into v_channel_id, v_conversation_id
    from public.messages m
    where m.id = p_message_id
      and m.deleted_at is null
    for update;

    if v_channel_id is null and v_conversation_id is null then
        raise exception 'Message does not exist' using errcode = 'P0002';
    end if;

    if v_conversation_id is not null then
        if not exists (
            select 1
            from public.conversation_participants cp
            where cp.conversation_id = v_conversation_id
              and cp.user_id = p_user_id
        ) then
            raise exception 'User is not a participant of this conversation'
                using errcode = '42501';
        end if;
    else
        select c.server_id into v_server_id
        from public.channels c
        where c.id = v_channel_id;

        if v_server_id is null or not exists (
            select 1
            from public.server_members sm
            where sm.server_id = v_server_id
              and sm.user_id = p_user_id
        ) then
            raise exception 'User cannot manage pins in this channel'
                using errcode = '42501';
        end if;
    end if;

    update public.messages m
    set pinned_at = case
            when p_pinned and m.pinned_at is null then clock_timestamp()
            when p_pinned then m.pinned_at
            else null
        end,
        pinned_by = case
            when p_pinned and m.pinned_at is null then p_user_id
            when p_pinned then m.pinned_by
            else null
        end
    where m.id = p_message_id;

    return query
    select
        m.id, m.channel_id, m.conversation_id, m.author_id, m.type, m.content,
        m.reply_to_id, m.sticker_provider, m.sticker_id, m.sticker_url,
        m.client_nonce, coalesce(m.is_forwarded, false),
        m.pinned_at, m.pinned_by, m.edited_at, m.deleted_at, m.created_at
    from public.messages m
    where m.id = p_message_id;
end;
$$;

revoke all on function public.set_message_pin(bigint, uuid, boolean)
    from public, anon, authenticated;
grant execute on function public.set_message_pin(bigint, uuid, boolean)
    to service_role;
