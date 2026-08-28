-- ===========================================================================
-- Tắt thông báo DM 1-1 theo tài khoản (đồng bộ đa thiết bị)
--
-- Trước đây danh sách "đã tắt thông báo" chỉ nằm trong localStorage của trình
-- duyệt → mỗi máy một kiểu, không theo tài khoản. Bảng này lưu server-side:
-- mỗi dòng = "user_id đã tắt thông báo DM từ muted_user_id".
--
-- RLS deny-all: chỉ backend (service_role) đọc/ghi, giống mọi bảng khác.
-- ===========================================================================

create table if not exists public.dm_notification_mutes (
    user_id       uuid not null references public.profiles(id) on delete cascade,
    muted_user_id uuid not null references public.profiles(id) on delete cascade,
    created_at    timestamptz not null default now(),
    primary key (user_id, muted_user_id),
    constraint dm_mute_not_self check (user_id <> muted_user_id)
);

-- Truy vấn chính: liệt kê mọi người mà user hiện tại đã tắt thông báo.
create index if not exists idx_dm_notification_mutes_user
    on public.dm_notification_mutes (user_id);

alter table public.dm_notification_mutes enable row level security;
-- Không tạo policy nào: anon/authenticated bị chặn, service_role bypass RLS.
