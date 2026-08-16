-- ============================================================================
-- Migration: Bổ sung template_id cho servers và RPC tạo server kèm channels theo mẫu
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bổ sung cột template_id vào bảng public.servers
-- ---------------------------------------------------------------------------
alter table public.servers
  add column if not exists template_id text not null default 'custom';

-- Thêm check constraint cho template_id nếu chưa có
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'servers_template_id_check'
  ) then
    alter table public.servers
      add constraint servers_template_id_check
      check (template_id in ('custom', 'gaming', 'friends', 'study', 'school_club'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Hàm RPC PostgreSQL: create_server_with_template
--
-- Thực thi trọn vẹn trong một transaction nguyên tử:
-- 1. Tạo bản ghi server kèm template_id
-- 2. Tạo membership OWNER cho người tạo
-- 3. Duyệt mảng JSON p_channels và tạo toàn bộ kênh theo đúng tên, loại, thứ tự
-- ---------------------------------------------------------------------------
create or replace function public.create_server_with_template(
  p_owner_id uuid,
  p_name text,
  p_template_id text,
  p_channels jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_server_id uuid;
  v_trimmed_name text;
  v_channel record;
  v_channels_result jsonb := '[]'::jsonb;
  v_channel_id uuid;
  v_chan_name text;
  v_chan_type text;
  v_chan_pos integer;
  v_result jsonb;
begin
  -- Validate tên máy chủ
  v_trimmed_name := trim(p_name);
  if char_length(v_trimmed_name) < 2 or char_length(v_trimmed_name) > 100 then
    raise exception 'Tên máy chủ phải từ 2 đến 100 ký tự' using errcode = '22023';
  end if;

  -- Validate template_id
  if p_template_id not in ('custom', 'gaming', 'friends', 'study', 'school_club') then
    raise exception 'Mẫu máy chủ không hợp lệ' using errcode = '22023';
  end if;

  -- Validate danh sách kênh
  if p_channels is null or jsonb_array_length(p_channels) = 0 then
    raise exception 'Danh sách kênh của mẫu không được rỗng' using errcode = '22023';
  end if;

  -- 1. Tạo máy chủ
  insert into public.servers (owner_id, name, template_id, icon_url)
  values (p_owner_id, v_trimmed_name, p_template_id, null)
  returning id into v_server_id;

  -- 2. Thêm owner vào server_members
  insert into public.server_members (server_id, user_id, role)
  values (v_server_id, p_owner_id, 'OWNER');

  -- 3. Thêm toàn bộ kênh từ mảng JSON
  for v_channel in select * from jsonb_to_recordset(p_channels) as x(name text, type text, position integer)
  loop
    v_chan_name := trim(v_channel.name);
    v_chan_type := coalesce(v_channel.type, 'text');
    v_chan_pos := coalesce(v_channel.position, 0);

    if v_chan_type not in ('text', 'voice') then
      raise exception 'Loại kênh không hợp lệ: %', v_chan_type using errcode = '22023';
    end if;

    insert into public.channels (server_id, name, type, position)
    values (v_server_id, v_chan_name, v_chan_type, v_chan_pos)
    returning id into v_channel_id;

    v_channels_result := v_channels_result || jsonb_build_object(
      'id', v_channel_id,
      'name', v_chan_name,
      'type', v_chan_type,
      'topic', null,
      'unread', false,
      'mentionCount', 0
    );
  end loop;

  -- 4. Gom dữ liệu trả về
  v_result := jsonb_build_object(
    'server', jsonb_build_object(
      'id', v_server_id,
      'name', v_trimmed_name,
      'templateId', p_template_id,
      'iconUrl', null,
      'unread', false,
      'mentionCount', 0
    ),
    'channels', v_channels_result
  );

  return v_result;
end;
$$;

-- Thu hồi quyền execute từ public/anon/authenticated, chỉ cấp cho service_role
revoke execute on function public.create_server_with_template(uuid, text, text, jsonb) from public;
revoke execute on function public.create_server_with_template(uuid, text, text, jsonb) from anon;
revoke execute on function public.create_server_with_template(uuid, text, text, jsonb) from authenticated;
grant execute on function public.create_server_with_template(uuid, text, text, jsonb) to service_role;
