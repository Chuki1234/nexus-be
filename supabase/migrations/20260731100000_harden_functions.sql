-- ============================================================================
-- Siết quyền trên các hàm — vá phát hiện của Supabase database linter
--
-- 1. Hai hàm trigger `fill_profile_email()` và `sync_profile_email()` khai báo
--    SECURITY DEFINER (bắt buộc, vì phải đọc schema `auth`). Nhưng chúng nằm
--    trong schema `public` nên PostgREST tự phơi thành endpoint RPC:
--        POST /rest/v1/rpc/fill_profile_email
--    và mặc định `anon` gọi được. Trái hẳn §3.3 — anon phải không làm được gì.
--
--    Thực tế khó khai thác: hàm trigger tham chiếu `new`, gọi ngoài ngữ cảnh
--    trigger sẽ bị Postgres từ chối. Nhưng "khó khai thác" không phải lý do để
--    một hàm SECURITY DEFINER mở cho người lạ.
--
--    Thu hồi EXECUTE KHÔNG làm hỏng trigger: trigger chạy theo quyền của chủ
--    bảng, không qua quyền EXECUTE của người gọi.
--
-- 2. `set_updated_at()` và `create_default_role()` chưa ghim `search_path`. Hàm
--    có search_path thay đổi được là đường để chèn schema giả mạo lên trước.
--    Thân hai hàm này đều đã dùng tên đầy đủ (`public.roles`, `now()`), nên ghim
--    rỗng là an toàn.
-- ============================================================================

revoke all on function public.fill_profile_email() from public, anon, authenticated;
revoke all on function public.sync_profile_email() from public, anon, authenticated;

-- create_default_role được NestJS gọi bằng service_role (bypass mọi grant), nên
-- không cần mở cho anon/authenticated.
revoke all on function public.create_default_role(uuid) from public, anon, authenticated;

alter function public.set_updated_at() set search_path = '';
alter function public.create_default_role(uuid) set search_path = '';
