-- =============================================================================
-- Thêm MÔ TẢ và TAG cho máy chủ — phục vụ card "giới thiệu máy chủ" khi dán link
-- origin/channels/:serverId vào khung chat (feature Profile Embed, Phase 6).
--
-- Vì sao cần: card giới thiệu muốn hiển thị mô tả ngắn + vài tag chủ đề (Gaming,
-- Công nghệ, Học tập...). Bảng `servers` hiện chỉ có name/icon/banner nên bổ sung
-- 2 cột này. (Ngày "Thành lập từ" dùng cột `created_at` đã có; số "Trực tuyến"
-- tính từ presence ở tầng ứng dụng, không lưu DB.)
--
-- An toàn chạy lại: dùng IF NOT EXISTS cho cột. Cột `tags` mặc định mảng rỗng để
-- các server cũ không bị null.
-- =============================================================================

alter table servers
  add column if not exists description text,
  add column if not exists tags text[] not null default '{}';

-- Mô tả tối đa 500 ký tự (đủ cho một đoạn giới thiệu ngắn, tránh lạm dụng).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'server_description_len'
  ) then
    alter table servers
      add constraint server_description_len
        check (description is null or char_length(description) <= 500);
  end if;
end $$;

-- Tối đa 10 tag mỗi server (đủ dùng, tránh phồng payload card).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'server_tags_count'
  ) then
    alter table servers
      add constraint server_tags_count
        check (array_length(tags, 1) is null or array_length(tags, 1) <= 10);
  end if;
end $$;
