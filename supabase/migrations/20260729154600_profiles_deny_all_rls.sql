-- ============================================================================
-- profiles — chuyển RLS về chế độ chặn hết (NEXUS_CONTEXT §3.3)
--
-- Hai policy tạo ở migration create_profiles cho phép mọi tài khoản đã đăng nhập
-- SELECT toàn bộ bảng. Nghĩa là chỉ cần một tài khoản bất kỳ là đọc được tên đăng
-- nhập, tên hiển thị, email và NGÀY SINH của tất cả người dùng còn lại.
--
-- Quyết định kiến trúc là không phân quyền bằng RLS: phân quyền nằm ở NestJS
-- Guards, còn RLS chỉ là chốt chặn cuối nếu khoá công khai bị lộ. Chốt chặn đó
-- chỉ có tác dụng khi không có policy nào cả.
--
-- Backend không bị ảnh hưởng: nó dùng service_role, vốn bỏ qua RLS.
--
-- ĐIỀU KIỆN TIÊN QUYẾT: frontend phải hết gọi `supabase.from('profiles')` trước
-- khi chạy migration này. Nếu chạy trong khi frontend còn tự đọc bảng thì truy
-- vấn sẽ lặng lẽ trả rỗng, và mọi người dùng đã có hồ sơ sẽ bị đá sang trang
-- hoàn tất hồ sơ rồi kẹt ở đó. (Đã chuyển sang GET /api/auth/me.)
-- ============================================================================

drop policy if exists "Người đã đăng nhập đọc được mọi hồ sơ" on public.profiles;
drop policy if exists "Chỉ sửa được hồ sơ của chính mình" on public.profiles;

-- RLS vẫn bật; không còn policy nào nghĩa là anon/authenticated không đọc, không
-- ghi được gì. Đây là trạng thái mong muốn, không phải thiếu sót.
alter table public.profiles enable row level security;

-- Thu hồi luôn quyền ở tầng GRANT: RLS chỉ lọc hàng, còn đây mới là quyền chạm
-- vào bảng. Hai lớp cùng đóng thì kể cả sau này ai đó lỡ thêm policy, PostgREST
-- vẫn không cho anon/authenticated đọc.
revoke all on public.profiles from anon, authenticated;
