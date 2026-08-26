-- Migration: 20260823140000_message_reactions_index.sql
-- Ghi chú: Bảng public.message_reactions đã được tạo trong 20260731110100_forum_threads.sql.
-- File này bổ sung index phụ cho user_id phục vụ truy vấn theo user (nếu cần).
-- Không tự ý apply remote mà chỉ lưu trữ trong codebase.

create index if not exists idx_message_reactions_user
    on public.message_reactions (user_id);
