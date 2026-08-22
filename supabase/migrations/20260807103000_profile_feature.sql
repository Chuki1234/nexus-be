-- ============================================================================
-- Tính năng Profile — mở rộng public.profiles + hai bucket ảnh
--
-- Bổ sung cho migration create_profiles: hồ sơ ban đầu chỉ có username /
-- display_name / birthdate, giờ thêm phần "trang cá nhân" thật sự — ảnh đại
-- diện, ảnh bìa, dòng trạng thái, giới thiệu và danh sách link ra ngoài.
--
-- Áp lên remote bằng `npx supabase db push`. Đừng sửa file này sau khi đã push.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Cột mới
--
-- avatar_url / banner_url lưu URL công khai đầy đủ do Supabase Storage sinh ra,
-- kèm `?v=<epoch>` để trình duyệt không dùng lại ảnh cũ đã cache (đường dẫn file
-- là cố định theo user nên upload mới ghi đè lên file cũ — xem MediaService).
-- Đánh đổi: đổi project Supabase thì phải viết lại các URL này.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_url     text,
  add column if not exists banner_url     text,
  add column if not exists status_message text,
  add column if not exists bio            text,
  add column if not exists location       text,
  -- Link tới trang/nội dung khác của người dùng (GitHub, YouTube, portfolio…).
  -- Dạng: [{"label": "GitHub", "url": "https://github.com/abc"}, ...]
  add column if not exists links          jsonb not null default '[]'::jsonb;

comment on column public.profiles.avatar_url is
  'URL công khai của ảnh đại diện (bucket avatars), kèm query cache-busting.';
comment on column public.profiles.banner_url is
  'URL công khai của ảnh bìa (bucket banners), kèm query cache-busting.';
comment on column public.profiles.status_message is
  'Dòng trạng thái ngắn hiện cạnh tên, tối đa 120 ký tự.';
comment on column public.profiles.links is
  'Mảng link ngoài, tối đa 5 phần tử {label, url}. Chỉ nhận https.';

-- ---------------------------------------------------------------------------
-- Ràng buộc độ dài — khớp với UpdateProfileDto bên backend.
-- Viết kiểu drop-rồi-add để chạy lại migration trên DB local không bị lỗi
-- "constraint đã tồn tại" (ALTER TABLE không có ADD CONSTRAINT IF NOT EXISTS).
-- ---------------------------------------------------------------------------
alter table public.profiles
  drop constraint if exists profiles_status_message_length,
  add constraint profiles_status_message_length check (
    status_message is null or char_length(status_message) between 1 and 120
  );

alter table public.profiles
  drop constraint if exists profiles_bio_length,
  add constraint profiles_bio_length check (
    bio is null or char_length(bio) between 1 and 300
  );

alter table public.profiles
  drop constraint if exists profiles_location_length,
  add constraint profiles_location_length check (
    location is null or char_length(location) between 1 and 64
  );

-- ---------------------------------------------------------------------------
-- Ràng buộc hình dạng cho `links`
--
-- CHECK không chứa được truy vấn con nên phải bọc qua hàm IMMUTABLE. CASE bảo
-- đảm thứ tự đánh giá: nếu không phải mảng thì thoát ngay, không gọi
-- jsonb_array_elements (hàm này ném lỗi khi đầu vào không phải mảng).
--
-- Dùng IS DISTINCT FROM chứ không phải <>: thiếu khoá thì `item -> 'label'` là
-- NULL, `jsonb_typeof(NULL) <> 'string'` cho NULL (không phải TRUE) nên mệnh đề
-- WHERE không khớp và object thiếu khoá sẽ lọt qua như thể hợp lệ.
--
-- Chỉ nhận https: link http lẫn vào trang https sẽ bị chặn/cảnh báo, còn
-- javascript: là lỗ XSS khi render thẳng vào href.
-- ---------------------------------------------------------------------------
create or replace function public.profile_links_valid(links jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when links is null then false
    when jsonb_typeof(links) <> 'array' then false
    when jsonb_array_length(links) > 5 then false
    else not exists (
      select 1
      from jsonb_array_elements(links) as item
      where jsonb_typeof(item) is distinct from 'object'
         or jsonb_typeof(item -> 'label') is distinct from 'string'
         or jsonb_typeof(item -> 'url') is distinct from 'string'
         or char_length(item ->> 'label') not between 1 and 32
         or char_length(item ->> 'url') not between 1 and 2048
         or item ->> 'url' !~ '^https://'
    )
  end;
$$;

comment on function public.profile_links_valid(jsonb) is
  'True khi links là mảng ≤5 phần tử {label:text, url:https-text}.';

alter table public.profiles
  drop constraint if exists profiles_links_shape,
  add constraint profiles_links_shape check (public.profile_links_valid(links));

-- ---------------------------------------------------------------------------
-- Tra cứu hồ sơ theo username
--
-- Ràng buộc unique đã tạo sẵn index cho `where username = ...`. Index dưới đây
-- phục vụ tìm kiếm theo tiền tố (`username like 'ab%'`) ở trang tìm bạn bè —
-- text_pattern_ops là bắt buộc, index B-tree mặc định không dùng được cho LIKE
-- khi collation không phải "C".
-- ---------------------------------------------------------------------------
create index if not exists profiles_username_prefix_idx
  on public.profiles (username text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Storage: bucket ảnh đại diện và ảnh bìa
--
-- public = true → ai cũng đọc được qua /storage/v1/object/public/... nên
-- <img src> không cần token. Đây là ảnh hồ sơ, vốn để công khai.
--
-- allowed_mime_types chỉ có image/webp: backend luôn resize + chuyển sang webp
-- trước khi upload, nên mọi định dạng khác vào được bucket đều là dấu hiệu có
-- ai đó đi vòng qua API.
--
-- file_size_limit là chặn ở phía Storage cho ảnh SAU khi nén; giới hạn với file
-- người dùng chọn (5 MB) nằm ở MediaService.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 1048576, array['image/webp']),
  ('banners', 'banners', true, 2097152, array['image/webp'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Cố tình KHÔNG tạo policy nào trên storage.objects cho hai bucket này:
--
--  · Đọc: bucket public được phục vụ qua /storage/v1/object/public/... và endpoint
--    đó không đi qua RLS, nên <img src> vẫn chạy dù bảng không có policy select.
--  · Ghi: RLS trên storage.objects đã bật sẵn trong Supabase, không policy nghĩa là
--    `anon`/`authenticated` không insert/update/delete được gì. Chỉ backend
--    (service_role, bỏ qua RLS) ghi được — nhờ vậy không ai nhét file vào thư mục
--    của người khác, và mọi ảnh trong bucket đều đã qua bước resize/kiểm tra.
--
-- Không `alter table storage.objects ...` ở đây: bảng đó thuộc sở hữu của
-- supabase_storage_admin, role chạy migration không đổi được thuộc tính bảng.
