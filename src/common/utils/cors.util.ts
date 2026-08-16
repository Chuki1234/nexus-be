/**
 * Chuẩn hóa danh sách CORS origins từ biến môi trường CORS_ORIGINS:
 * - Cắt theo dấu phẩy
 * - Xóa khoảng trắng đầu/cuối
 * - Cắt bỏ dấu gạch chéo cuối URL (trailing slash) để khớp chính xác với header Origin chuẩn RFC 6454
 * - Loại bỏ các giá trị rỗng hoặc ký tự đại diện '*' (vì request có Authorization Bearer header không tương thích với '*')
 * - Fallback an toàn về ['http://localhost:4200'] nếu rỗng.
 */
export function normalizeCorsOrigins(rawOrigins?: string): string[] {
  const defaultOrigin = 'http://localhost:4200';

  if (!rawOrigins || typeof rawOrigins !== 'string') {
    return [defaultOrigin];
  }

  const origins = rawOrigins
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0 && origin !== '*');

  return origins.length > 0 ? origins : [defaultOrigin];
}
