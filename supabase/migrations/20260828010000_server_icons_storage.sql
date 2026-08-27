-- ===========================================================================
-- BUCKET: server-icons (Public)
--
-- Lưu ảnh icon của máy chủ sau khi được resize bởi backend.
-- Public = true: frontend có thể hiển thị trực tiếp qua public URL mà không cần
-- signed URL (icon máy chủ không phải nội dung riêng tư).
--
-- Upload đi qua NestJS backend (service_role) để resize + validate trước khi lưu.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'server-icons',
  'server-icons',
  true,
  2097152, -- 2 MB tối đa sau khi resize (webp 512x512 @ q82 luôn nhỏ hơn nhiều)
  array['image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
