-- ============================================================================
-- profiles.games — trò chơi người dùng khoe trên hồ sơ (widget kiểu Discord)
--
-- Bốn widget dùng CHUNG một cột jsonb, phân biệt bằng khoá `kind`:
--   rotation  Trò Chơi Luân Phiên   tối đa 5, có nhãn
--   favorite  Trò Chơi Yêu Thích    tối đa 1
--   like      Trò Chơi Tôi Thích    tối đa 20
--   wishlist  Muốn Chơi             tối đa 20
--
-- Vì sao một cột jsonb chứ không phải bảng riêng: cả bốn danh sách đều nhỏ
-- (tổng ≤46 mục/người), luôn được đọc kèm hồ sơ, và không bao giờ cần query
-- riêng (không ai hỏi "ai đang chơi Elden Ring"). Bảng riêng chỉ thêm một join
-- vào mọi lần xem hồ sơ. Đây cũng đúng khuôn cột `links` đã có.
-- ============================================================================

alter table public.profiles
  add column if not exists games jsonb not null default '[]'::jsonb;

comment on column public.profiles.games is
  'Trò chơi khoe trên hồ sơ. Mảng {id,kind,title,cover,tags}. Xem profile_games_valid().';

-- ---------------------------------------------------------------------------
-- Hàm kiểm hợp lệ, dùng làm CHECK constraint.
--
-- `immutable` là BẮT BUỘC: Postgres từ chối dùng hàm volatile/stable trong CHECK.
--
-- Thứ tự các nhánh trong CASE cũng bắt buộc, không được viết lại thành chuỗi
-- `and`: `jsonb_array_elements` NÉM LỖI khi đầu vào không phải mảng, mà Postgres
-- không bảo đảm thứ tự đánh giá của AND/OR — phải chặn kiểu dữ liệu trước.
--
-- Dùng `is distinct from` chứ không phải `<>` khi kiểm `jsonb_typeof(item -> 'k')`:
-- với `<>`, khoá THIẾU cho ra NULL nên cả biểu thức thành NULL, WHERE không khớp,
-- và object thiếu khoá lọt qua như thể hợp lệ.
--
-- Chỉ nhận ảnh bìa `https://`: `http` lẫn vào trang https bị chặn, còn
-- `javascript:` là lỗ XSS nếu có chỗ nào render thẳng vào thuộc tính.
-- ---------------------------------------------------------------------------
create or replace function public.profile_games_valid(games jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when games is null then false
    when jsonb_typeof(games) <> 'array' then false
    when jsonb_array_length(games) > 46 then false
    -- Hình dạng từng phần tử.
    when exists (
      select 1
      from jsonb_array_elements(games) as item
      where jsonb_typeof(item) is distinct from 'object'
         or jsonb_typeof(item -> 'id') is distinct from 'string'
         or jsonb_typeof(item -> 'kind') is distinct from 'string'
         or jsonb_typeof(item -> 'title') is distinct from 'string'
         or jsonb_typeof(item -> 'tags') is distinct from 'array'
         or (item ->> 'kind') not in ('rotation', 'favorite', 'like', 'wishlist')
         or char_length(item ->> 'id') not between 1 and 128
         or char_length(item ->> 'title') not between 1 and 64
         -- cover: cho phép null, còn lại phải là chuỗi https ngắn hơn 2048.
         or (
              jsonb_typeof(item -> 'cover') not in ('null', 'string')
           or (jsonb_typeof(item -> 'cover') = 'string' and (
                   char_length(item ->> 'cover') > 2048
                or item ->> 'cover' !~ '^https://'
              ))
         )
         or jsonb_array_length(item -> 'tags') > 4
         -- Từng nhãn phải là chuỗi 1..24 ký tự.
         or exists (
              select 1
              from jsonb_array_elements(item -> 'tags') as tag
              where jsonb_typeof(tag) is distinct from 'string'
                 or char_length(tag #>> '{}') not between 1 and 24
         )
    ) then false
    -- `id` phải duy nhất: Angular @for ném lỗi runtime khi track trùng khoá.
    when (
      select count(distinct item ->> 'id') from jsonb_array_elements(games) as item
    ) <> jsonb_array_length(games) then false
    -- Hạn mức riêng từng widget.
    when (select count(*) from jsonb_array_elements(games) as i
          where i ->> 'kind' = 'rotation') > 5 then false
    when (select count(*) from jsonb_array_elements(games) as i
          where i ->> 'kind' = 'favorite') > 1 then false
    when (select count(*) from jsonb_array_elements(games) as i
          where i ->> 'kind' = 'like') > 20 then false
    when (select count(*) from jsonb_array_elements(games) as i
          where i ->> 'kind' = 'wishlist') > 20 then false
    else true
  end;
$$;

comment on function public.profile_games_valid(jsonb) is
  'True khi games là mảng ≤46 phần tử {id,kind,title,cover,tags} hợp lệ, id duy nhất, đúng hạn mức từng widget.';

alter table public.profiles
  drop constraint if exists profiles_games_shape,
  add constraint profiles_games_shape check (public.profile_games_valid(games));

-- ---------------------------------------------------------------------------
-- KHÔNG thêm policy nào cho bảng profiles ở đây.
--
-- RLS của `profiles` đang bật với 0 policy — đó là CỐ Ý: mọi truy cập đi qua
-- backend bằng service_role (bỏ qua RLS), nên không ai đọc/ghi thẳng từ client
-- được. Thêm policy ở đây là vô tình mở một cửa mới.
-- ---------------------------------------------------------------------------
