-- ============================================================================
-- DM MESSAGE REQUESTS ("Người lạ")
--
-- Cho phép hai thành viên CHUNG SERVER nhắn tin dù chưa kết bạn. Tin nhắn đầu
-- tiên từ người chưa-kết-bạn sẽ nằm ở mục "chờ duyệt / Người lạ" của người nhận:
--   - Người khởi tạo (gửi trước)  -> request_state = 'accepted' (được nhắn).
--   - Người nhận                  -> request_state = 'pending'  (chỉ đọc tới khi
--                                     bấm "Chấp nhận").
--
-- Mặc định 'accepted' để mọi hàng CŨ (DM bạn bè đang hoạt động) không bị ảnh
-- hưởng. Chỉ DM người-lạ mới đặt 'pending' cho phía người nhận (do tầng service
-- đặt lúc tạo cuộc trò chuyện). "Từ chối" = xoá hẳn conversation nên không cần
-- trạng thái 'declined'.
-- ============================================================================

alter table public.conversation_participants
    add column if not exists request_state text not null default 'accepted';

alter table public.conversation_participants
    drop constraint if exists conversation_participants_request_state_check;

alter table public.conversation_participants
    add constraint conversation_participants_request_state_check
    check (request_state in ('pending', 'accepted'));

-- Lọc nhanh các "message request" đang chờ của một user.
create index if not exists idx_conv_participants_pending
    on public.conversation_participants (user_id)
    where request_state = 'pending';
