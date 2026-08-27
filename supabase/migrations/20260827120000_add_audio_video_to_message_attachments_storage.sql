-- ===========================================================================
-- MIGRATION: Cho phép audio/video đã được backend kiểm định trong attachment
--
-- Chỉ cập nhật whitelist MIME của bucket hiện hữu. Không thay đổi trạng thái
-- private, giới hạn 10 MB, RLS hay policy ghi/đọc của message-attachments.
-- ===========================================================================

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
  'audio/mpeg',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
  'video/3gpp',
  'video/x-ms-wmv',
  'video/x-flv',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]::text[]
where id = 'message-attachments';

