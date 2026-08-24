-- ============================================================================
-- mfa_backup_codes — mã dự phòng 2FA (Supabase MFA chỉ có TOTP, không có backup)
--
-- Mỗi user có tối đa 10 mã dùng-một-lần. Lưu HASH (sha-256) chứ không lưu mã
-- gốc: kể cả service_role hay ai lộ khoá cũng không đọc ra mã. Verify bằng cách
-- hash mã người nhập rồi so, và đánh dấu `used_at` để không dùng lại.
--
-- RLS bật, KHÔNG policy (deny-all) — đúng chủ ý toàn dự án: phân quyền ở NestJS
-- Guards, backend dùng service_role vốn bỏ qua RLS.
-- ============================================================================

create table if not exists public.mfa_backup_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- Tra nhanh mã còn hiệu lực của một user khi verify lúc đăng nhập.
create index if not exists mfa_backup_codes_user_active_idx
  on public.mfa_backup_codes (user_id)
  where used_at is null;

alter table public.mfa_backup_codes enable row level security;

comment on table public.mfa_backup_codes is
  'Mã dự phòng 2FA dùng-một-lần (hash sha-256). RLS deny-all, chỉ NestJS service_role truy cập.';
