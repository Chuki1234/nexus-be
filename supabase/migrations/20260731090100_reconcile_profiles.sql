-- ============================================================================
-- profiles — hoà giải bảng đang chạy với docs/nexus_schema.sql
--
-- Bảng này đã tồn tại từ migration create_profiles (25/07) và đang có dữ liệu
-- thật, nên phải ALTER chứ không drop-recreate.
--
-- Sáu điểm lệch được xử lý ở đây:
--   1. birthdate            -> date_of_birth
--   2. email, username      -> citext (so sánh không phân biệt hoa/thường)
--   3. email chưa unique    -> thêm unique
--   4. thiếu 6 cột hiển thị -> phone, avatar_url, banner_url, status_message,
--                              manual_presence, last_seen_at
--   5. CHECK dùng current_date -> thay bằng biểu thức immutable (lý do ở dưới)
--   6. hàm touch_updated_at -> đổi sang set_updated_at cho khớp tên trong schema gốc
--
-- Regex username giữ nguyên {3,32} — đã chốt 31/07, khớp RegisterDto và form Angular.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Đổi tên cột ngày sinh
-- ---------------------------------------------------------------------------
alter table public.profiles rename column birthdate to date_of_birth;

-- ---------------------------------------------------------------------------
-- 2. CHECK ngày sinh: bỏ current_date
--
-- `birthdate <= current_date` là biểu thức KHÔNG immutable. Hai hậu quả: dòng
-- đang hợp lệ có thể thành không hợp lệ theo thời gian, và pg_dump/restore có thể
-- lỗi. Ngưỡng "đủ 13 tuổi" vốn đã được kiểm ở tầng DTO (IsBirthdate), nên ở DB
-- chỉ giữ chặn khoảng vô lý.
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_birthdate_range;

alter table public.profiles
    add constraint profiles_date_of_birth_range
    check (date_of_birth >= date '1900-01-01');

-- ---------------------------------------------------------------------------
-- 3. Đổi kiểu sang citext
--
-- Phải bỏ CHECK username trước khi đổi kiểu, rồi tạo lại với ép kiểu ::text —
-- regex chạy trên citext sẽ so sánh không phân biệt hoa/thường và vô tình cho
-- lọt username viết hoa.
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_username_format;

alter table public.profiles
    alter column username type citext using username::citext,
    alter column email    type citext using email::citext;

alter table public.profiles
    add constraint profiles_username_format
    check (username::text ~ '^[a-z0-9_.]{3,32}$');

-- ---------------------------------------------------------------------------
-- 4. email phải là duy nhất (mirror của auth.users.email, vốn đã unique)
-- ---------------------------------------------------------------------------
create unique index if not exists profiles_email_key on public.profiles (email);

-- ---------------------------------------------------------------------------
-- 5. Các cột hiển thị còn thiếu
-- ---------------------------------------------------------------------------
alter table public.profiles
    add column if not exists phone           text,
    add column if not exists avatar_url      text,
    add column if not exists banner_url      text,
    add column if not exists status_message  text,
    add column if not exists manual_presence presence_status not null default 'online',
    add column if not exists last_seen_at    timestamptz;

comment on column public.profiles.phone is
    'Thông tin hồ sơ, định dạng E.164. KHÔNG dùng để đăng nhập (NEXUS_CONTEXT §3.6).';

create unique index if not exists profiles_phone_key
    on public.profiles (phone) where phone is not null;

alter table public.profiles
    add constraint profiles_phone_e164
    check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$');

alter table public.profiles
    add constraint profiles_status_message_len
    check (status_message is null or char_length(status_message) <= 128);

create index if not exists idx_profiles_username on public.profiles (username);

-- ---------------------------------------------------------------------------
-- 6. Thống nhất tên hàm cập nhật updated_at
--
-- Migration cũ tạo touch_updated_at(); schema gốc gọi nó là set_updated_at().
-- Giữ hai hàm giống hệt nhau là mầm mống lệch về sau — chuyển hẳn sang một tên.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated
    before update on public.profiles
    for each row execute function public.set_updated_at();

drop function if exists public.touch_updated_at();
