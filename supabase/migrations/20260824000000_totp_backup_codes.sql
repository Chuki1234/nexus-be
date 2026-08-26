-- ─────────────────────────────────────────────────────────────────────────────
-- TOTP Backup Codes
--
-- Lưu backup codes cho 2FA. Mỗi code được bcrypt hash trước khi lưu.
-- Khi đăng nhập bằng backup code, code đó bị đánh dấu là đã dùng (used_at).
-- Chỉ backend (service_role) được đọc/ghi bảng này — RLS chặn hoàn toàn từ client.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.totp_backup_codes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  code_hash  text        not null,     -- bcrypt hash của mã gốc 8-char hex
  used_at    timestamptz,              -- null = chưa dùng
  created_at timestamptz default now() not null
);

-- Index tra cứu theo user
create index if not exists totp_backup_codes_user_id_idx
  on public.totp_backup_codes (user_id);

-- RLS: bật nhưng không có policy nào → client không đọc/ghi được
alter table public.totp_backup_codes enable row level security;

-- Không tạo policy nào: service_role bypass RLS → backend dùng được bình thường.
-- Frontend (anon / authenticated) bị chặn hoàn toàn.
