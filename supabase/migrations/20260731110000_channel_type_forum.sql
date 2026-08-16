-- ============================================================================
-- Thêm giá trị 'forum' vào channel_type
--
-- Tách riêng một file chỉ để làm việc này. Postgres không cho phép DÙNG giá trị
-- enum mới trong cùng transaction vừa thêm nó, mà Supabase CLI bọc mỗi migration
-- trong một transaction — gộp chung với phần tạo bảng ở file sau sẽ lỗi.
-- ============================================================================

alter type channel_type add value if not exists 'forum';
