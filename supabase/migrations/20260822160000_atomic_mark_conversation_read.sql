-- ============================================================================
-- ATOMIC MARK CONVERSATION READ RPC
--
-- RPC nguyên tử cập nhật trạng thái đã đọc cho Direct Messages:
-- 1. Kiểm tra quyền participant (42501 nếu không phải thành viên)
-- 2. Kiểm tra message tồn tại và đúng conversation_id (22023 nếu sai)
-- 3. Atomic upsert với partial index `(user_id, conversation_id) WHERE conversation_id IS NOT NULL`
-- 4. Chỉ update khi EXCLUDED.last_read_message_id > COALESCE(last_read_message_id, 0)
-- 5. Trả về last_read_message_id dạng TEXT để không mất chính xác bigint
-- 6. Bảo vệ SECURITY DEFINER: Chỉ cấp quyền EXECUTE cho service_role
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mark_conversation_read(
  p_user_id UUID,
  p_conversation_id UUID,
  p_message_id BIGINT
)
RETURNS TABLE (
  success BOOLEAN,
  updated BOOLEAN,
  last_read_message_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_new_last_read BIGINT;
  v_updated BOOLEAN;
BEGIN
  -- 1. Kiểm tra quyền thành viên trong conversation
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'User is not a participant of this conversation'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Kiểm tra message tồn tại và thuộc đúng conversation
  IF NOT EXISTS (
    SELECT 1 FROM public.messages
    WHERE id = p_message_id AND conversation_id = p_conversation_id
  ) THEN
    RAISE EXCEPTION 'Message does not exist in this conversation'
      USING ERRCODE = '22023';
  END IF;

  -- 3. Atomic Upsert với partial unique index và điều kiện monotonic
  INSERT INTO public.read_states (
    user_id,
    conversation_id,
    last_read_message_id,
    mention_count,
    updated_at
  )
  VALUES (
    p_user_id,
    p_conversation_id,
    p_message_id,
    0,
    NOW()
  )
  ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
  DO UPDATE SET
    last_read_message_id = EXCLUDED.last_read_message_id,
    mention_count = 0,
    updated_at = NOW()
  WHERE EXCLUDED.last_read_message_id > COALESCE(public.read_states.last_read_message_id, 0)
  RETURNING public.read_states.last_read_message_id INTO v_new_last_read;

  IF FOUND THEN
    v_updated := TRUE;
  ELSE
    v_updated := FALSE;
    SELECT read_states.last_read_message_id INTO v_new_last_read
    FROM public.read_states
    WHERE read_states.user_id = p_user_id AND read_states.conversation_id = p_conversation_id;
  END IF;

  RETURN QUERY SELECT
    TRUE AS success,
    v_updated AS updated,
    v_new_last_read::TEXT AS last_read_message_id;
END;
$$;

-- Bảo mật hàm: Thu hồi quyền từ public/anon/authenticated, chỉ cho phép service_role
REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(UUID, UUID, BIGINT) TO service_role;
