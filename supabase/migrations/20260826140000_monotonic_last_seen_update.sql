-- Migration: Bổ sung hàm cập nhật profiles.last_seen_at đơn điệu (monotonic)
-- Ngày tạo: 2026-08-26
-- Mô tả: Tránh trường hợp worker trễ/stale ghi đè mốc thời gian cũ lên mốc thời gian mới hơn.

CREATE OR REPLACE FUNCTION public.update_profile_last_seen(
  p_user_id uuid,
  p_last_seen_at timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.profiles
  SET last_seen_at = GREATEST(COALESCE(last_seen_at, '-infinity'::timestamptz), p_last_seen_at)
  WHERE id = p_user_id;
$$;

-- PostgreSQL mặc định cấp EXECUTE cho PUBLIC trên function mới. RPC này chỉ
-- dành cho backend service role để client không thể sửa last_seen_at user khác.
REVOKE ALL ON FUNCTION public.update_profile_last_seen(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_profile_last_seen(uuid, timestamptz)
  TO service_role;
