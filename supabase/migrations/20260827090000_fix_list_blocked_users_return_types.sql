-- Fix SQLSTATE 42804 in list_blocked_users.
-- profiles.username is citext while the RPC contract returns text.
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
        p.username::text,
        p.display_name::text,
        p.avatar_url::text,
        ub.created_at::timestamptz as blocked_at
    from public.user_blocks ub
    join public.profiles p on p.id = ub.blocked_user_id
    where ub.blocker_id = p_user_id
    order by ub.created_at desc;
end;
$$;

revoke all on function public.list_blocked_users(uuid) from public, anon, authenticated;
grant execute on function public.list_blocked_users(uuid) to service_role;
