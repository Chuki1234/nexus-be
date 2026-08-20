-- ============================================================================
-- profiles.email — bản sao email từ auth.users
--
-- Đăng nhập cho phép nhập tên đăng nhập thay email (NEXUS_CONTEXT §3.6). Backend
-- phải đổi `username` → `email` rồi mới gọi Supabase đăng nhập được. PostgREST
-- không đọc được schema `auth`, nên nếu không có cột này thì mỗi lần đăng nhập
-- bằng username phải gọi thêm Admin API để tra email — hai vòng mạng thay vì một.
--
-- Cột này chỉ để ĐỌC. Nguồn sự thật vẫn là auth.users; hai trigger dưới đây giữ
-- cho nó luôn khớp, không nơi nào trong ứng dụng được tự ghi đè.
-- ============================================================================

alter table public.profiles
  add column if not exists email text;

comment on column public.profiles.email is
  'Bản sao auth.users.email, đồng bộ bằng trigger. Chỉ đọc — đừng ghi trực tiếp.';

-- ---------------------------------------------------------------------------
-- Điền cho các hồ sơ đã tạo trước migration này
-- ---------------------------------------------------------------------------
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- ---------------------------------------------------------------------------
-- Lúc TẠO hồ sơ: tự lấy email từ auth.users
--
-- Trigger trên auth.users không lo được việc này: backend tạo auth user TRƯỚC
-- rồi mới insert profiles, nên lúc auth user sinh ra chưa có hàng nào để cập nhật.
--
-- security definer để đọc được schema auth (vai trò gọi insert không có quyền đó).
-- ---------------------------------------------------------------------------
create or replace function public.fill_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  select u.email into new.email
    from auth.users u
   where u.id = new.id;
  return new;
end;
$$;

drop trigger if exists profiles_fill_email on public.profiles;
create trigger profiles_fill_email
  before insert on public.profiles
  for each row execute function public.fill_profile_email();

-- ---------------------------------------------------------------------------
-- Khi user ĐỔI email: đồng bộ ngược xuống profiles
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email = new.email
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_sync_profile_email on auth.users;
create trigger trg_sync_profile_email
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.sync_profile_email();

-- ---------------------------------------------------------------------------
-- Chốt lại sau khi đã điền xong: từ đây mọi hồ sơ đều phải có email
-- ---------------------------------------------------------------------------
alter table public.profiles
  alter column email set not null;
