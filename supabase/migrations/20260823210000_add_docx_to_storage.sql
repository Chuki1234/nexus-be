-- ===========================================================================
-- MIGRATION: Bổ sung MIME DOCX vào bucket message-attachments
--
-- Idempotent: Bảo toàn 100% public = false, giới hạn 10MB và toàn bộ MIME cũ.
-- Chỉ bổ sung MIME DOCX nếu chưa tồn tại trong allowed_mime_types.
-- Xử lý an toàn trường hợp allowed_mime_types IS NULL.
-- ===========================================================================

update storage.buckets
set allowed_mime_types = array_append(
  coalesce(allowed_mime_types, array[]::text[]),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
)
where id = 'message-attachments'
  and not (
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    = any(coalesce(allowed_mime_types, array[]::text[]))
  );
