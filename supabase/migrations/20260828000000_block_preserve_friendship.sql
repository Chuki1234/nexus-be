-- ============================================================================
-- Migration: 20260828000000_block_preserve_friendship.sql
-- Fix: block_user không còn xóa friendship row.
-- Trước đây: chặn bạn bè → xóa hẳn friendship → bỏ chặn mất bạn bè luôn.
-- Sau: friendship được giữ nguyên; listFriends lọc block ở tầng service.
-- ============================================================================

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
    if p_blocker_id is null or p_blocked_user_id is null then
        raise exception 'Tham số blocker_id và blocked_user_id là bắt buộc' using errcode = '22023';
    end if;

    if p_blocker_id = p_blocked_user_id then
        raise exception 'Không thể tự chặn chính mình' using errcode = '22023';
    end if;

    if not exists (select 1 from public.profiles where id = p_blocker_id) then
        raise exception 'Người dùng thực hiện chặn không tồn tại' using errcode = 'P0002';
    end if;

    select id, username, display_name, avatar_url into v_blocked_profile
    from public.profiles
    where id = p_blocked_user_id;

    if not found then
        raise exception 'Người dùng bị chặn không tồn tại' using errcode = 'P0002';
    end if;

    v_u1 := least(p_blocker_id, p_blocked_user_id);
    v_u2 := greatest(p_blocker_id, p_blocked_user_id);

    perform pg_advisory_xact_lock(hashtext(v_u1::text));
    perform pg_advisory_xact_lock(hashtext(v_u2::text));

    -- Ghi quan hệ chặn (idempotent)
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

    -- KHÔNG xóa friendship: friendship được giữ lại để restore khi bỏ chặn.
    -- Service layer lọc bỏ blocked users khỏi danh sách bạn bè khi hiển thị.

    -- Dọn dẹp cuộc gọi đang active giữa 2 bên
    for v_terminated_call in
        select id, livekit_room_name
        from public.direct_calls
        where ((caller_id = p_blocker_id and callee_id = p_blocked_user_id) or
               (caller_id = p_blocked_user_id and callee_id = p_blocker_id))
          and status in ('ringing', 'accepted')
    loop
        update public.direct_calls
        set status = 'ended',
            ended_at = clock_timestamp(),
            ended_by = p_blocker_id,
            end_reason = 'blocked_or_unfriended',
            version = version + 1,
            updated_at = clock_timestamp()
        where id = v_terminated_call.id;

        delete from public.direct_call_active_users
        where call_id = v_terminated_call.id;

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
