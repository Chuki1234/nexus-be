-- ===========================================================================
-- BUCKET: message-attachments (Private)
--
-- Dành riêng cho file và ảnh đính kèm trong tin nhắn Direct Messages / Kênh.
-- Bucket ở trạng thái PRIVATE (public = false): không ai có thể truy cập file
-- trực tiếp qua public URL nếu chưa có signed URL hợp lệ từ backend.
--
-- Luồng ghi: Backend qua service_role (canonical REST endpoint) kiểm tra
-- membership, quét dung lượng/magic bytes, lưu file vào Storage và ghi metadata
-- vào bảng public.attachments.
-- Luồng đọc: Backend tạo Signed URL có thời hạn (1 giờ) cho người tham gia.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  false,
  10485760, -- 10 MB tối đa mỗi file
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'application/zip',
    'application/x-zip-compressed'
  ]
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Cố tình KHÔNG mở insert/update/delete policy cho role authenticated/anon.
-- Toàn bộ việc upload file bắt buộc phải đi qua canonical write path của NestJS backend
-- (sử dụng service_role) để đảm bảo membership authorization, kiểm tra content magic bytes,
-- tạo bản ghi bảng attachments và phòng chống orphan files.
