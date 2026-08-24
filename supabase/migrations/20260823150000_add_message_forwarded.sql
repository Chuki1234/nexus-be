-- ============================================================================
-- Migration: 20260823150000_add_message_forwarded.sql
-- Description: Bổ sung cột is_forwarded vào bảng public.messages và RPC
--              create_forwarded_message để tạo tin nhắn kèm attachments nguyên tử (atomic).
-- Phân quyền: REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT TO service_role.
-- Lưu ý: Chỉ tạo local để tài liệu hóa schema, không tự ý apply remote.
-- ============================================================================

-- 1. Cột is_forwarded trên bảng public.messages
alter table if exists public.messages
    add column if not exists is_forwarded boolean not null default false;

-- 2. Index hỗ trợ lọc tin nhắn chuyển tiếp nếu cần
create index if not exists idx_messages_forwarded
    on public.messages (conversation_id, id desc)
    where is_forwarded = true;

-- ----------------------------------------------------------------------------
-- RPC: public.create_forwarded_message
-- Ghi nguyên tử (single transaction) message row và attachments metadata.
-- Ngăn ngừa hoàn toàn hiện tượng race condition hoặc message thiếu attachments
-- xuất hiện trong cursor pagination / realtime feed.
-- ----------------------------------------------------------------------------
create or replace function public.create_forwarded_message(
  p_author_id uuid,
  p_conversation_id uuid,
  p_content text,
  p_client_nonce uuid,
  p_attachments jsonb default '[]'::jsonb
)
returns table (
  message_id text,
  conversation_id uuid,
  author_id uuid,
  content text,
  type text,
  is_forwarded boolean,
  reply_to_id text,
  client_nonce uuid,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz,
  attachments jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_msg public.messages%rowtype;
  v_att_json jsonb := '[]'::jsonb;
begin
  -- 1. Yêu cầu bắt buộc client_nonce
  if p_client_nonce is null then
    raise exception 'Client nonce is required.'
      using errcode = '22023';
  end if;

  -- 2. Kiểm tra quyền thành viên trong cuộc trò chuyện đích (Defense-in-depth)
  if not exists (
    select 1 from public.conversation_participants as cp
    where cp.conversation_id = p_conversation_id and cp.user_id = p_author_id
  ) then
    raise exception 'User % is not a participant of target conversation %', p_author_id, p_conversation_id
      using errcode = '42501';
  end if;

  -- 3. Kiểm tra kiểu dữ liệu của p_attachments (phải là jsonb array)
  if p_attachments is not null and pg_catalog.jsonb_typeof(p_attachments) <> 'array' then
    raise exception 'p_attachments must be a jsonb array.'
      using errcode = '22023';
  end if;

  -- 4. Kiểm tra tính hợp lệ của nội dung và attachments
  if (p_content is null or pg_catalog.char_length(pg_catalog.btrim(p_content)) = 0)
     and (p_attachments is null or pg_catalog.jsonb_array_length(p_attachments) = 0) then
    raise exception 'Tin nhắn phải có nội dung văn bản hoặc ít nhất một tệp đính kèm.'
      using errcode = '22023';
  end if;

  if p_content is not null and pg_catalog.char_length(p_content) > 4000 then
    raise exception 'Nội dung tin nhắn vượt quá 4000 ký tự cho phép.'
      using errcode = '22023';
  end if;

  if p_attachments is not null and pg_catalog.jsonb_array_length(p_attachments) > 5 then
    raise exception 'Chỉ được đính kèm tối đa 5 tệp mỗi tin nhắn.'
      using errcode = '22023';
  end if;

  -- 5. Validate attachment metadata và prefix storage_path
  if p_attachments is not null and pg_catalog.jsonb_array_length(p_attachments) > 0 then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_attachments) as elem
      where
        -- (a) storage_path prefix & non-empty
        (elem->>'storage_path') is null
        or pg_catalog.char_length(pg_catalog.btrim(elem->>'storage_path')) = 0
        or not pg_catalog.starts_with(
          elem->>'storage_path',
          'conversations/' || p_conversation_id::text || '/'
        )
        -- (b) filename non-empty
        or (elem->>'filename') is null
        or pg_catalog.char_length(pg_catalog.btrim(elem->>'filename')) = 0
        -- (c) mime_type non-empty
        or (elem->>'mime_type') is null
        or pg_catalog.char_length(pg_catalog.btrim(elem->>'mime_type')) = 0
        -- (d) size_bytes > 0
        or (elem->>'size_bytes') is null
        or (elem->>'size_bytes')::bigint <= 0
        -- (e) width null hoặc > 0
        or ((elem->>'width') is not null and (elem->>'width')::integer <= 0)
        -- (f) height null hoặc > 0
        or ((elem->>'height') is not null and (elem->>'height')::integer <= 0)
    ) then
      raise exception 'Invalid attachment metadata: storage_path prefix, filename, mime_type, positive size_bytes, and valid width/height are required.'
        using errcode = '22023';
    end if;
  end if;

  -- 6. Insert message row (sẽ raise unique_violation 23505 nếu client_nonce đã tồn tại cho author_id)
  insert into public.messages (
    conversation_id,
    author_id,
    content,
    type,
    is_forwarded,
    reply_to_id,
    client_nonce,
    created_at
  )
  values (
    p_conversation_id,
    p_author_id,
    nullif(pg_catalog.btrim(p_content), ''),
    'default',
    true,
    null,
    p_client_nonce,
    pg_catalog.now()
  )
  returning * into v_msg;

  -- 7. Insert attachments metadata trong cùng 1 transaction nguyên tử
  if p_attachments is not null and pg_catalog.jsonb_array_length(p_attachments) > 0 then
    with inserted_atts as (
      insert into public.attachments (
        message_id,
        storage_path,
        filename,
        mime_type,
        size_bytes,
        width,
        height
      )
      select
        v_msg.id,
        (elem->>'storage_path')::text,
        (elem->>'filename')::text,
        (elem->>'mime_type')::text,
        (elem->>'size_bytes')::bigint,
        (elem->>'width')::integer,
        (elem->>'height')::integer
      from pg_catalog.jsonb_array_elements(p_attachments) as elem
      returning
        public.attachments.id,
        public.attachments.message_id,
        public.attachments.storage_path,
        public.attachments.filename,
        public.attachments.mime_type,
        public.attachments.size_bytes,
        public.attachments.width,
        public.attachments.height,
        public.attachments.created_at
    )
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', ia.id::text,
        'message_id', ia.message_id::text,
        'storage_path', ia.storage_path,
        'filename', ia.filename,
        'mime_type', ia.mime_type,
        'size_bytes', ia.size_bytes,
        'width', ia.width,
        'height', ia.height,
        'created_at', ia.created_at
      )
    ) into v_att_json
    from inserted_atts as ia;
  end if;

  -- 8. Trả về bản ghi hoàn chỉnh (toàn bộ ID định dạng text để bảo toàn độ chính xác bigint)
  return query
  select
    v_msg.id::text as message_id,
    v_msg.conversation_id as conversation_id,
    v_msg.author_id as author_id,
    v_msg.content as content,
    v_msg.type::text as type,
    v_msg.is_forwarded as is_forwarded,
    v_msg.reply_to_id::text as reply_to_id,
    v_msg.client_nonce as client_nonce,
    v_msg.edited_at as edited_at,
    v_msg.deleted_at as deleted_at,
    v_msg.created_at as created_at,
    coalesce(v_att_json, '[]'::jsonb) as attachments;
end;
$$;

-- ----------------------------------------------------------------------------
-- PHÂN QUYỀN THỰC THI (SECURITY REVIEW)
-- 1. Thu hồi quyền execute từ PUBLIC, anon, authenticated (chặn frontend gọi trực tiếp)
-- 2. Chỉ cấp quyền execute cho role service_role (NestJS Backend gọi sau khi xác thực JWT)
-- ----------------------------------------------------------------------------
revoke all on function public.create_forwarded_message(uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.create_forwarded_message(uuid, uuid, text, uuid, jsonb)
  to service_role;
