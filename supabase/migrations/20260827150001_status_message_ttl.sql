-- ============================================================================
-- Trạng thái tuỳ chỉnh ("custom status") tự hết hạn sau 24h
-- ============================================================================
-- Trước đây `profiles.status_message` là text thuần, tồn tại vĩnh viễn tới khi
-- user tự đổi. Yêu cầu mới: status chỉ hiển thị trong 24h kể từ lúc LƯU, sau đó
-- tự biến mất ở mọi nơi. Thời hạn cố định, user không cấu hình được.
--
-- Cơ chế hai lớp:
--   1. Cột `status_message_expires_at` ghi mốc hết hạn (BE set = now()+24h mỗi
--      lần lưu; xoá trắng thì = null).
--   2. Backend lọc lúc đọc hồ sơ (ẩn tức thì) + job pg_cron dọn cột định kỳ để
--      các surface khác (danh sách chat, bạn bè) cũng tự sạch.
--
-- PHẦN A (bắt buộc): thêm cột + backfill. Chạy được ngay kể cả khi chưa bật cron.
-- PHẦN B (khuyến nghị): job pg_cron — cần bật extension pg_cron trên Supabase
--   (Database → Extensions). Nếu chưa bật thì bỏ qua Phần B, hồ sơ vẫn ẩn đúng
--   nhờ bộ lọc ở backend; chỉ là danh sách chat/bạn bè phải chờ user đó được
--   đọc lại mới cập nhật.
-- ============================================================================

-- ── PHẦN A ──────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists status_message_expires_at timestamptz;

comment on column public.profiles.status_message_expires_at is
  'Mốc hết hạn của status tuỳ chỉnh (now()+24h khi lưu). NULL = không có status.';

-- Backfill: status đang tồn tại được gia hạn 24h kể từ lúc chạy migration này,
-- rồi mới bắt đầu đếm ngược như status mới. Không backfill thì bộ lọc backend sẽ
-- coi chúng là hết hạn (không có mốc) và ẩn ngay lập tức.
update public.profiles
   set status_message_expires_at = now() + interval '24 hours'
 where status_message is not null
   and btrim(status_message) <> ''
   and status_message_expires_at is null;

-- ── PHẦN B (khuyến nghị) ─────────────────────────────────────────────────────
-- Bỏ comment khối dưới sau khi đã bật extension pg_cron.
--
-- create extension if not exists pg_cron;
--
-- -- cron.schedule idempotent theo tên job (chạy lại migration không tạo trùng).
-- select cron.schedule(
--   'clear-expired-status',
--   '* * * * *',
--   $$
--     update public.profiles
--        set status_message = null,
--            status_message_expires_at = null
--      where status_message_expires_at is not null
--        and status_message_expires_at < now();
--   $$
-- );
