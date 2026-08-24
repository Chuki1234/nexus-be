-- ============================================================================
-- Migration: Server Invitations, Link Joins & Channel Creation with Hardened RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bảng lưu trữ lời mời tham gia máy chủ trực tiếp giữa người dùng
-- ---------------------------------------------------------------------------
create table if not exists public.server_invitations (
    id          uuid primary key default gen_random_uuid(),
    server_id   uuid not null references public.servers(id) on delete cascade,
    inviter_id  uuid not null references auth.users(id) on delete cascade,
    invitee_id  uuid not null references auth.users(id) on delete cascade,
    status      text not null default 'pending',
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null default (now() + interval '7 days'),

    constraint server_invitations_status_check
        check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    constraint server_invitations_not_self_check
        check (inviter_id <> invitee_id)
);

alter table public.server_invitations enable row level security;

create index if not exists idx_server_invitations_invitee_status
    on public.server_invitations (invitee_id, status);

create index if not exists idx_server_invitations_server_status
    on public.server_invitations (server_id, status);

-- Partial Unique Index: Mỗi người dùng chỉ có tối đa 1 lời mời 'pending' còn hiệu lực trên 1 server
create unique index if not exists idx_server_invitations_unique_pending
    on public.server_invitations (server_id, invitee_id)
    where status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. RPC chấp nhận lời mời trực tiếp nguyên tử & Idempotent
-- ---------------------------------------------------------------------------
create or replace function public.accept_server_invitation(
    p_invitation_id uuid,
    p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_inv record;
    v_already_member boolean;
    v_inserted_rows integer;
begin
    if p_invitation_id is null or p_user_id is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    -- 1. Khóa bản ghi invitation
    select * into v_inv
    from public.server_invitations
    where id = p_invitation_id
    for update;

    if not found then
        raise exception 'Lời mời không tồn tại' using errcode = 'P0002';
    end if;

    if v_inv.invitee_id <> p_user_id then
        raise exception 'Bạn không phải là người nhận lời mời này' using errcode = '42501';
    end if;

    -- 2. Idempotent: Nếu đã accepted trước đó, chỉ trả thành công nếu thành viên vẫn còn trong server
    if v_inv.status = 'accepted' then
        select exists (
            select 1 from public.server_members
            where server_id = v_inv.server_id and user_id = p_user_id
        ) into v_already_member;

        if v_already_member then
            return pg_catalog.jsonb_build_object(
                'success', true,
                'serverId', v_inv.server_id,
                'alreadyMember', true
            );
        else
            return pg_catalog.jsonb_build_object(
                'success', false,
                'reason', 'already_used',
                'message', 'Lời mời này đã được sử dụng trước đó'
            );
        end if;
    end if;

    -- 3. Xử lý hết hạn: Chỉ đổi pending quá hạn thành expired (không ghi đè declined/revoked)
    if v_inv.status = 'pending' and v_inv.expires_at <= now() then
        update public.server_invitations
        set status = 'expired'
        where id = p_invitation_id;

        return pg_catalog.jsonb_build_object(
            'success', false,
            'reason', 'expired',
            'message', 'Lời mời đã hết hạn'
        );
    end if;

    -- 4. Nếu không phải pending (declined, revoked, expired)
    if v_inv.status <> 'pending' then
        return pg_catalog.jsonb_build_object(
            'success', false,
            'reason', v_inv.status,
            'message', format('Lời mời không còn khả dụng (trạng thái: %s)', v_inv.status)
        );
    end if;

    -- 5. Thêm thành viên chống race condition với ON CONFLICT DO NOTHING
    insert into public.server_members (server_id, user_id, role)
    values (v_inv.server_id, p_user_id, 'MEMBER')
    on conflict (server_id, user_id) do nothing;

    get diagnostics v_inserted_rows = row_count;

    -- 6. Đánh dấu lời mời đã được chấp nhận
    update public.server_invitations
    set status = 'accepted'
    where id = p_invitation_id;

    return pg_catalog.jsonb_build_object(
        'success', true,
        'serverId', v_inv.server_id,
        'alreadyMember', (v_inserted_rows = 0)
    );
end;
$$;

revoke all on function public.accept_server_invitation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_server_invitation(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. RPC tham gia server qua link mời chống race-condition & kiểm tra slot
-- ---------------------------------------------------------------------------
create or replace function public.join_server_by_invite_code(
    p_code text,
    p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_inv record;
    v_already_member boolean;
    v_inserted_rows integer;
    v_clean_code text;
    v_current_uses integer;
begin
    if p_code is null or length(trim(p_code)) = 0 or p_user_id is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    v_clean_code := trim(p_code);

    -- 1. Khóa bản ghi invite
    select * into v_inv
    from public.invites
    where code = v_clean_code
    for update;

    if not found then
        raise exception 'Mã mời không tồn tại hoặc đã bị xóa' using errcode = 'P0002';
    end if;

    -- 2. Kiểm tra already-member TRƯỚC expiry/max-use để retry sau khi hết hạn/hết lượt vẫn idempotent
    select exists (
        select 1 from public.server_members
        where server_id = v_inv.server_id and user_id = p_user_id
    ) into v_already_member;

    if v_already_member then
        return pg_catalog.jsonb_build_object(
            'success', true,
            'serverId', v_inv.server_id,
            'channelId', v_inv.channel_id,
            'alreadyMember', true
        );
    end if;

    v_current_uses := coalesce(v_inv.uses, 0);

    -- 3. Kiểm tra hạn dùng (expires_at IS NULL nghĩa là không hết hạn)
    if v_inv.expires_at is not null and v_inv.expires_at <= now() then
        raise exception 'Liên kết mời đã hết hạn' using errcode = '22023';
    end if;

    -- 4. Kiểm tra max_uses (max_uses IS NULL nghĩa là không giới hạn)
    if v_inv.max_uses is not null and v_current_uses >= v_inv.max_uses then
        raise exception 'Liên kết mời đã đạt số lượt sử dụng tối đa' using errcode = '22023';
    end if;

    -- 5. Thêm thành viên chống race condition với ON CONFLICT DO NOTHING
    insert into public.server_members (server_id, user_id, role)
    values (v_inv.server_id, p_user_id, 'MEMBER')
    on conflict (server_id, user_id) do nothing;

    get diagnostics v_inserted_rows = row_count;

    -- 6. Chỉ tăng lượt sử dụng nếu thực sự thêm thành viên mới thành công
    if v_inserted_rows = 1 then
        update public.invites
        set uses = coalesce(uses, 0) + 1
        where code = v_inv.code;
    end if;

    return pg_catalog.jsonb_build_object(
        'success', true,
        'serverId', v_inv.server_id,
        'channelId', v_inv.channel_id,
        'alreadyMember', (v_inserted_rows = 0)
    );
end;
$$;

revoke all on function public.join_server_by_invite_code(text, uuid) from public, anon, authenticated;
grant execute on function public.join_server_by_invite_code(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. RPC tạo kênh mới có Advisory Lock trước permission check & validation đầy đủ
-- ---------------------------------------------------------------------------
create or replace function public.create_server_channel(
    p_server_id uuid,
    p_user_id uuid,
    p_name text,
    p_type text,
    p_topic text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_owner_id uuid;
    v_member_role text;
    v_base_perms bigint;
    v_is_authorized boolean := false;
    v_next_pos integer;
    v_channel_id uuid;
    v_chan_type public.channel_type;
    v_trimmed_name text;
    v_trimmed_topic text;
begin
    if p_server_id is null or p_user_id is null or p_name is null or p_type is null then
        raise exception 'Tham số không hợp lệ' using errcode = '22023';
    end if;

    v_trimmed_name := trim(p_name);
    if length(v_trimmed_name) < 1 or length(v_trimmed_name) > 100 then
        raise exception 'Tên kênh phải từ 1 đến 100 ký tự' using errcode = '22023';
    end if;

    -- Chặn ký tự điều khiển (control characters)
    if v_trimmed_name ~ '[[:cntrl:]]' then
        raise exception 'Tên kênh chứa ký tự không hợp lệ' using errcode = '22023';
    end if;

    if p_type not in ('text', 'voice') then
        raise exception 'Loại kênh chỉ có thể là "text" hoặc "voice"' using errcode = '22023';
    end if;

    if p_topic is not null and char_length(p_topic) > 1024 then
        raise exception 'Chủ đề kênh vượt quá giới hạn' using errcode = '22023';
    end if;

    v_chan_type := p_type::public.channel_type;
    v_trimmed_topic := case when p_topic is not null and length(trim(p_topic)) > 0 then trim(p_topic) else null end;

    -- 1. Advisory Lock theo serverId được lấy TRƯỚC permission check
    -- Giúp thu hẹp đáng kể cửa sổ TOCTOU. Mọi mutation thay đổi role/member permission
    -- trong tương lai cũng phải sử dụng cùng server lock này để bảo đảm chống TOCTOU hoàn chỉnh.
    perform pg_advisory_xact_lock(hashtextextended(p_server_id::text, 0));

    -- 2. Kiểm tra quyền nội tại bên trong transaction
    select owner_id into v_owner_id
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

    -- Owner hoặc Legacy ADMIN luôn có toàn quyền
    if v_owner_id = p_user_id or v_member_role in ('OWNER', 'ADMIN') then
        v_is_authorized := true;
    else
        -- Tính quyền từ @everyone và các role được gán (không dùng channel_overwrites)
        select coalesce(bit_or(r.permissions), 0::bigint) into v_base_perms
        from public.roles r
        where r.server_id = p_server_id and (
            r.is_default = true or
            exists (
                select 1 from public.member_roles mr
                where mr.role_id = r.id and mr.user_id = p_user_id and mr.server_id = p_server_id
            )
        );

        -- MANAGE_CHANNELS = 1n << 4n = 16n, ADMINISTRATOR = 1n << 62n = 4611686018427387904n
        if (v_base_perms & 16::bigint) <> 0 or (v_base_perms & 4611686018427387904::bigint) <> 0 then
            v_is_authorized := true;
        end if;
    end if;

    if not v_is_authorized then
        raise exception 'Bạn không có quyền quản lý kênh trong máy chủ này' using errcode = '42501';
    end if;

    -- 3. Tính position kế tiếp
    select coalesce(max(position), -1) + 1 into v_next_pos
    from public.channels
    where server_id = p_server_id;

    -- 4. Chèn kênh mới
    insert into public.channels (server_id, name, type, topic, position)
    values (p_server_id, v_trimmed_name, v_chan_type, v_trimmed_topic, v_next_pos)
    returning id into v_channel_id;

    return pg_catalog.jsonb_build_object(
        'id', v_channel_id,
        'serverId', p_server_id,
        'name', v_trimmed_name,
        'type', p_type,
        'topic', v_trimmed_topic,
        'position', v_next_pos,
        'unread', false,
        'mentionCount', 0
    );
end;
$$;

revoke all on function public.create_server_channel(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_server_channel(uuid, uuid, text, text, text) to service_role;
