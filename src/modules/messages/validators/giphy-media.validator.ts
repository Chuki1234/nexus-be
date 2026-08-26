import { BadRequestException } from '@nestjs/common';
import type { ExternalMediaDto } from '../../../shared/dto/messages.dto';

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

export const ALLOWED_STIPOP_MEDIA_HOSTS = new Set<string>([
  'img.stipop.io',
  'stipop.io',
  'www.stipop.io',
  'messenger.stipop.io',
]);

export const ALLOWED_STIPOP_PAGE_HOSTS = new Set<string>([
  'stipop.io',
  'www.stipop.io',
  'img.stipop.io',
]);

const MEDIA_ID_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;

/**
 * Chuẩn hoá và kiểm tra hostname nghiêm ngặt (exact / anchored matching).
 * Chống bypass domain: evil.com, punycode, credentials, IP, v.v.
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
      `${fieldName} có tên miền "${hostname}" không thuộc danh sách được phép.`,
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
 * Validate toàn bộ ExternalMediaDto (GIPHY / Stipop) trước khi persist vào database.
 */
export function validateAndSanitizeExternalMedia(
  media: unknown,
): ExternalMediaDto {
  if (!media || typeof media !== 'object') {
    throw new BadRequestException('Dữ liệu externalMedia không hợp lệ.');
  }

  const m = media as Record<string, unknown>;
  const provider = m['provider'];

  if (provider !== 'giphy' && provider !== 'stipop') {
    throw new BadRequestException('Provider của externalMedia chỉ có thể là "giphy" hoặc "stipop".');
  }

  const mediaType = m['mediaType'];
  if (provider === 'giphy' && mediaType !== 'gif') {
    throw new BadRequestException('mediaType của GIPHY chỉ có thể là "gif".');
  }
  if (provider === 'stipop' && mediaType !== 'sticker' && mediaType !== 'gif') {
    throw new BadRequestException('mediaType của Stipop chỉ có thể là "sticker" hoặc "gif".');
  }

  const externalId = String(m['externalId'] || '').trim();
  if (!MEDIA_ID_REGEX.test(externalId)) {
    throw new BadRequestException('externalId của media không đúng định dạng hợp lệ.');
  }

  const width = typeof m['width'] === 'number' ? m['width'] : parseInt(String(m['width']), 10);
  const height = typeof m['height'] === 'number' ? m['height'] : parseInt(String(m['height']), 10);

  if (isNaN(width) || width <= 0 || width > 4096) {
    throw new BadRequestException('Chiều rộng (width) của media phải là số nguyên dương từ 1 đến 4096.');
  }

  if (isNaN(height) || height <= 0 || height > 4096) {
    throw new BadRequestException('Chiều cao (height) của media phải là số nguyên dương từ 1 đến 4096.');
  }

  const pageAllowedHosts = provider === 'giphy' ? ALLOWED_GIPHY_PAGE_HOSTS : ALLOWED_STIPOP_PAGE_HOSTS;
  const mediaAllowedHosts = provider === 'giphy' ? ALLOWED_GIPHY_MEDIA_HOSTS : ALLOWED_STIPOP_MEDIA_HOSTS;

  const pageUrl = normalizeAndValidateUrl(
    String(m['pageUrl'] || ''),
    pageAllowedHosts,
    'pageUrl',
  );

  const previewUrl = normalizeAndValidateUrl(
    String(m['previewUrl'] || ''),
    mediaAllowedHosts,
    'previewUrl',
  );

  const displayUrl = normalizeAndValidateUrl(
    String(m['displayUrl'] || ''),
    mediaAllowedHosts,
    'displayUrl',
  );

  let mp4Url: string | null = null;
  if (m['mp4Url'] !== null && m['mp4Url'] !== undefined && String(m['mp4Url']).trim() !== '') {
    mp4Url = normalizeAndValidateUrl(
      String(m['mp4Url']),
      mediaAllowedHosts,
      'mp4Url',
    );
  }

  const title = sanitizePlainText(m['title'] as string, 255) || (provider === 'stipop' ? 'Sticker' : 'GIF');
  const creatorUsername = sanitizePlainText(m['creatorUsername'] as string, 100);

  return {
    provider,
    externalId,
    mediaType: mediaType as 'gif' | 'sticker',
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

/**
 * Tương thích ngược với tên gọi cũ
 */
export const validateAndSanitizeGiphyMedia = validateAndSanitizeExternalMedia;
