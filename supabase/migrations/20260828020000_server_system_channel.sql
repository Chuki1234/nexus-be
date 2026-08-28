-- ===========================================================================
-- Kênh hệ thống (system channel) cho máy chủ
--
-- Mỗi máy chủ chỉ định MỘT kênh chữ làm "kênh chính" — nơi hiển thị tin nhắn
-- hoạt động system_join / system_leave khi thành viên tham gia / rời máy chủ.
--
-- Trước đây các tin nhắn này luôn rơi vào "kênh chữ đầu tiên theo position",
-- không cho chủ máy chủ chọn. Cột system_channel_id cho phép chỉ định rõ ràng;
-- nếu null thì logic gửi tin nhắn hệ thống vẫn fallback về kênh chữ đầu tiên.
-- ===========================================================================

-- 1. Thêm cột system_channel_id (on delete set null: xoá kênh chính -> về fallback)
alter table public.servers
  add column if not exists system_channel_id uuid
    references public.channels(id) on delete set null;

-- 2. Backfill cho máy chủ hiện có: gán kênh chữ đầu tiên theo position
update public.servers s
set system_channel_id = sub.id
from (
  select distinct on (server_id) server_id, id
  from public.channels
  where type = 'text'
  order by server_id, position asc, created_at asc
) sub
where sub.server_id = s.id
  and s.system_channel_id is null;

-- 3. Cập nhật RPC tạo server: tự set system_channel_id = kênh chữ đầu tiên
drop function if exists public.create_server_with_template(uuid, text, text, jsonb);

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
    v_server_id       uuid;
    v_clean_name      text;
    v_channel         jsonb;
    v_channel_name    text;
    v_channel_type    public.channel_type;
    v_position        integer;
    v_topic           text;
    v_channels_out    jsonb := '[]'::jsonb;
    v_ch_id           uuid;
    v_ch_name_out     text;
    v_ch_type_out     public.channel_type;
    v_ch_topic_out    text;
    v_sys_channel_id  uuid := null;
    v_sys_channel_pos integer := null;
begin
    -- Validate tên máy chủ
    v_clean_name := trim(p_name);
    if v_clean_name is null or length(v_clean_name) < 2 or length(v_clean_name) > 100 then
        raise exception 'Tên máy chủ phải từ 2 đến 100 ký tự'
            using errcode = '22023';
    end if;

    -- 1. Tạo máy chủ
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

    -- 2. Thêm owner vào server_members
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

    -- 3. Tạo role mặc định @everyone với quyền chuẩn (3339)
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
        3339::bigint,
        0,
        true
    );

    -- 4. Thêm các kênh từ p_channels
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

            -- Ghi nhớ kênh chữ có position nhỏ nhất làm kênh hệ thống mặc định
            if v_channel_type = 'text'::public.channel_type
               and (v_sys_channel_pos is null or v_position < v_sys_channel_pos) then
                v_sys_channel_id := v_ch_id;
                v_sys_channel_pos := v_position;
            end if;

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

    -- Nhánh fallback nếu không có kênh nào: tạo kênh 'chung'
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

        v_sys_channel_id := v_ch_id;

        v_channels_out := jsonb_build_array(jsonb_build_object(
            'id', v_ch_id,
            'name', v_ch_name_out,
            'type', v_ch_type_out,
            'topic', v_ch_topic_out,
            'unread', false,
            'mentionCount', 0
        ));
    end if;

    -- 5. Gán kênh hệ thống mặc định (kênh chữ đầu tiên)
    if v_sys_channel_id is not null then
        update public.servers
        set system_channel_id = v_sys_channel_id
        where id = v_server_id;
    end if;

    -- 6. Trả kết quả
    return jsonb_build_object(
        'server', jsonb_build_object(
            'id', v_server_id,
            'name', v_clean_name,
            'templateId', nullif(trim(p_template_id), ''::text),
            'iconUrl', null,
            'systemChannelId', v_sys_channel_id,
            'unread', false,
            'mentionCount', 0
        ),
        'channels', v_channels_out
    );
end;
$$;

revoke all on function public.create_server_with_template(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_server_with_template(uuid, text, text, jsonb) to service_role;
