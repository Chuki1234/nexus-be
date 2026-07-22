-- ============================================================================
-- public.profiles — hồ sơ người dùng Nexus
--
-- Chạy file này trong Supabase SQL Editor (một lần) trước khi gọi POST /api/auth/register.
--
-- auth.users chỉ giữ email + mật khẩu. Tên đăng nhập, tên hiển thị và ngày sinh
-- nằm ở đây vì user_metadata KHÔNG ép được ràng buộc duy nhất — hai người có thể
-- cùng đăng ký một username mà Supabase không hề báo lỗi.
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  display_name text,
  birthdate date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Trùng khít regex ở RegisterDto (backend) và register.page (frontend).
  -- Đã ép chữ thường tại tầng DTO nên chỉ nhận a-z; unique thường là đủ,
  -- không cần thêm unique index trên lower(username).
  constraint profiles_username_format check (username ~ '^[a-z0-9_.]{3,32}$'),
  constraint profiles_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 32
  ),
  -- Chặn ngày sinh vô lý ngay ở tầng DB. Ngưỡng 13 tuổi được kiểm ở backend
  -- (cần "hôm nay"), ở đây chỉ chặn khoảng không thể đúng.
  constraint profiles_birthdate_range check (
    birthdate between date '1900-01-01' and current_date
  )
);

comment on table public.profiles is 'Hồ sơ công khai của người dùng, 1-1 với auth.users.';

-- ---------------------------------------------------------------------------
-- updated_at tự động
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- KHÔNG có policy INSERT: chỉ backend (service_role) được tạo hồ sơ, và
-- service_role bỏ qua RLS. Client cầm anon key không tự chèn hồ sơ được,
-- nên không ai giành trước username của người khác.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "Người đã đăng nhập đọc được mọi hồ sơ" on public.profiles;
create policy "Người đã đăng nhập đọc được mọi hồ sơ"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "Chỉ sửa được hồ sơ của chính mình" on public.profiles;
create policy "Chỉ sửa được hồ sơ của chính mình"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
