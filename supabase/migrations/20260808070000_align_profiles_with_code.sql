-- ============================================================================
-- Đồng bộ public.profiles trên remote với code
--
-- Bảng `profiles` trên project Supabase đã bị sửa ngoài luồng migration: nó mang
-- những cột không migration nào ở đây tạo ra (email, phone, manual_presence,
-- last_seen_at) và đặt tên ngày sinh là `date_of_birth`, trong khi toàn bộ code
-- hai repo (nexus-be lẫn nexus-fe) đọc/ghi `birthdate`.
--
-- Hệ quả trước khi chạy file này:
--  · GET /api/profiles/me lỗi 500 — câu select có cột `birthdate` không tồn tại.
--  · POST /api/auth/register lỗi 500 — insert vào cột `birthdate` không tồn tại.
--
-- Áp lên remote bằng `npx supabase db push`. Đừng sửa file này sau khi đã push.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- date_of_birth → birthdate
--
-- Có điều kiện chứ không rename thẳng: trên DB dựng từ đầu bằng đúng bộ migration
-- này, create_profiles đã tạo sẵn `birthdate` và không hề có `date_of_birth` —
-- rename thẳng sẽ làm migration gãy ở môi trường sạch (và ở lần chạy lại thứ hai).
--
-- Đổi tên chứ không thêm cột mới rồi copy: giữ nguyên dữ liệu, ràng buộc và
-- NOT NULL sẵn có, đồng thời không để lại hai cột ngày sinh dễ dùng nhầm.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'date_of_birth'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'birthdate'
  ) then
    alter table public.profiles rename column date_of_birth to birthdate;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quyền đọc cho vai trò `authenticated`
--
-- create_profiles đã tạo policy "Người đã đăng nhập đọc được mọi hồ sơ", nhưng
-- policy chỉ lọc dòng — nó KHÔNG cấp quyền trên bảng. Project Supabase mới không
-- còn tự cấp quyền cho anon/authenticated khi có bảng mới (xem ghi chú
-- `auto_expose_new_tables` trong supabase/config.toml), nên bảng này đang trả
-- 42501 "permission denied for table profiles" cho cả người đã đăng nhập.
--
-- Chỗ vỡ vì thiếu dòng GRANT dưới đây là `profileGuard` bên frontend: nó hỏi
-- Supabase trực tiếp xem tài khoản đã có hồ sơ chưa, nhận lỗi quyền, hiểu nhầm
-- thành "chưa có hồ sơ" rồi đẩy người dùng sang trang hoàn tất hồ sơ — nơi
-- backend trả 409 "Hồ sơ đã được tạo trước đó". Không vào được trang hồ sơ nào.
--
-- Chỉ SELECT: mọi thao tác ghi đều đi qua backend bằng service_role, để một chỗ
-- duy nhất kiểm tra dữ liệu (UpdateProfileDto). Vì vậy policy UPDATE trong
-- create_profiles hiện là policy chết — cố ý, đừng cấp thêm quyền để "kích hoạt"
-- nó trừ khi thật sự cho client tự ghi hồ sơ.
--
-- Không cấp cho `anon`: hồ sơ chỉ công khai trong phạm vi ứng dụng, người chưa
-- đăng nhập không đọc được gì.
-- ---------------------------------------------------------------------------
grant select on table public.profiles to authenticated;
