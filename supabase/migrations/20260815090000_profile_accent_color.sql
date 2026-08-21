-- ============================================================================
-- Accent color — người dùng tự chọn màu nhận diện thay vì để hệ thống băm từ
-- username.
--
-- Chỉ dùng cho MỘT việc trong đợt này: màu nền ảnh bìa khi chưa tải ảnh lên.
-- `bannerFallback()` bên frontend đã băm username ra 8 màu cố định — cột này
-- cho người dùng ghi đè kết quả đó, giữ nguyên chính 8 màu ấy (đã được kiểm
-- chứng phù hợp cho nền trang trí, không có chữ đè lên) để không phải làm lại
-- kiểm tra tương phản trên cả 5 theme cho một bảng màu mới.
--
-- Áp lên remote bằng `npx supabase db push`. Đừng sửa file này sau khi đã push.
-- ============================================================================

alter table public.profiles
  add column if not exists accent_color text;

comment on column public.profiles.accent_color is
  'Màu nền ảnh bìa do người dùng tự chọn, ghi đè màu băm từ username. NULL = tự động theo username.';

-- Giới hạn đúng 8 giá trị hex trong BANNER_FALLBACKS (banner-color.ts). Ba nơi
-- phải khớp nhau khi đổi bảng màu về sau: constraint này, @IsIn trong
-- UpdateProfileDto, và hằng số BANNER_FALLBACKS bên frontend.
alter table public.profiles
  drop constraint if exists profiles_accent_color_valid,
  add constraint profiles_accent_color_valid check (
    accent_color is null or accent_color in (
      '#4453c4', '#2f7a68', '#7c46b8', '#a8514c',
      '#a8752a', '#37628f', '#8d3f6b', '#3f7a3a'
    )
  );
