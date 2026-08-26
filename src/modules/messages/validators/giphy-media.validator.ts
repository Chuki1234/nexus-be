import { BadRequestException } from '@nestjs/common';
import type { GiphyMediaDto } from '../../../shared/dto/messages.dto';

export const ALLOWED_GIPHY_MEDIA_HOSTS = new Set<string>([
  'media.giphy.com',
  'media0.giphy.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
]);

export const ALLOWED_GIPHY_PAGE_HOSTS = new Set<string>([
  'giphy.com',
  'www.giphy.com',
]);

const GIPHY_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;

/**
 * Chuẩn hoá và kiểm tra hostname nghiêm ngặt (exact / anchored matching).
 * Chống bypass domain: evilgiphy.com, giphy.com.attacker.com, punycode, credentials, IP, v.v.
 */
export function normalizeAndValidateUrl(
  rawUrl: string,
  allowedHosts: Set<string>,
  fieldName: string,
): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new BadRequestException(`${fieldName} phải là một URL hợp lệ.`);
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    throw new BadRequestException(
      `${fieldName} vượt quá độ dài tối đa 2048 ký tự.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException(
      `${fieldName} không đúng định dạng URL hợp lệ.`,
    );
  }

  // 1. Chỉ chấp nhận HTTPS
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException(
      `${fieldName} phải sử dụng giao thức an toàn https://.`,
    );
  }

  // 2. Chặn URL chứa credentials (user:password@)
  if (parsed.username || parsed.password) {
    throw new BadRequestException(
      `${fieldName} không được chứa thông tin xác thực (credentials).`,
    );
  }

  // 3. Chặn cổng tùy ý (chỉ chấp nhận cổng mặc định hoặc 443)
  if (parsed.port && parsed.port !== '443') {
    throw new BadRequestException(
      `${fieldName} không được chỉ định cổng khác 443.`,
    );
  }

  // 4. Chuẩn hóa hostname (lowercase, xóa trailing dot)
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }
  parsed.hostname = hostname;

  // 5. Kiểm tra exact allowlist
  if (!allowedHosts.has(hostname)) {
    throw new BadRequestException(
      `${fieldName} có tên miền "${hostname}" không thuộc danh sách GIPHY được phép.`,
    );
  }

  return parsed.toString();
}

/**
 * Sanitize plain text (xóa thẻ HTML, giới hạn độ dài).
 */
export function sanitizePlainText(
  text: string | null | undefined,
  maxLength: number,
): string | null {
  if (text === null || text === undefined) return null;
  const stripped = String(text).replace(/<[^>]*>/g, '').trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLength);
}

/**
 * Validate toàn bộ GiphyMediaDto trước khi persist vào database.
 */
export function validateAndSanitizeGiphyMedia(
  media: unknown,
): GiphyMediaDto {
  if (!media || typeof media !== 'object') {
    throw new BadRequestException('Dữ liệu externalMedia không hợp lệ.');
  }

  const m = media as Record<string, unknown>;

  if (m['provider'] !== 'giphy') {
    throw new BadRequestException('Provider của externalMedia chỉ có thể là "giphy".');
  }

  if (m['mediaType'] !== 'gif') {
    throw new BadRequestException('mediaType của externalMedia chỉ có thể là "gif".');
  }

  const externalId = String(m['externalId'] || '').trim();
  if (!GIPHY_ID_REGEX.test(externalId)) {
    throw new BadRequestException('externalId của GIPHY không đúng định dạng hợp lệ.');
  }

  const width = typeof m['width'] === 'number' ? m['width'] : parseInt(String(m['width']), 10);
  const height = typeof m['height'] === 'number' ? m['height'] : parseInt(String(m['height']), 10);

  if (isNaN(width) || width <= 0 || width > 4096) {
    throw new BadRequestException('Chiều rộng (width) của GIF phải là số nguyên dương từ 1 đến 4096.');
  }

  if (isNaN(height) || height <= 0 || height > 4096) {
    throw new BadRequestException('Chiều cao (height) của GIF phải là số nguyên dương từ 1 đến 4096.');
  }

  const pageUrl = normalizeAndValidateUrl(
    String(m['pageUrl'] || ''),
    ALLOWED_GIPHY_PAGE_HOSTS,
    'pageUrl',
  );

  const previewUrl = normalizeAndValidateUrl(
    String(m['previewUrl'] || ''),
    ALLOWED_GIPHY_MEDIA_HOSTS,
    'previewUrl',
  );

  const displayUrl = normalizeAndValidateUrl(
    String(m['displayUrl'] || ''),
    ALLOWED_GIPHY_MEDIA_HOSTS,
    'displayUrl',
  );

  let mp4Url: string | null = null;
  if (m['mp4Url'] !== null && m['mp4Url'] !== undefined && String(m['mp4Url']).trim() !== '') {
    mp4Url = normalizeAndValidateUrl(
      String(m['mp4Url']),
      ALLOWED_GIPHY_MEDIA_HOSTS,
      'mp4Url',
    );
  }

  const title = sanitizePlainText(m['title'] as string, 255) || 'GIF';
  const creatorUsername = sanitizePlainText(m['creatorUsername'] as string, 100);

  return {
    provider: 'giphy',
    externalId,
    mediaType: 'gif',
    title,
    creatorUsername,
    pageUrl,
    previewUrl,
    displayUrl,
    mp4Url,
    width,
    height,
  };
}
