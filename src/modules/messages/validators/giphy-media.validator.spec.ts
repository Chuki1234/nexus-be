import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_GIPHY_MEDIA_HOSTS,
  ALLOWED_GIPHY_PAGE_HOSTS,
  normalizeAndValidateUrl,
  validateAndSanitizeGiphyMedia,
} from './giphy-media.validator';

describe('GiphyMediaValidator', () => {
  const validMediaPayload = {
    provider: 'giphy',
    externalId: 'YQitOmg976101WnSYP',
    mediaType: 'gif',
    title: 'Happy Cat Dancing GIF',
    creatorUsername: 'catvibes',
    pageUrl: 'https://giphy.com/gifs/cat-dance-YQitOmg976101WnSYP',
    previewUrl: 'https://media.giphy.com/media/YQitOmg976101WnSYP/200w.webp',
    displayUrl: 'https://media0.giphy.com/media/YQitOmg976101WnSYP/giphy.gif',
    mp4Url: 'https://media1.giphy.com/media/YQitOmg976101WnSYP/giphy.mp4',
    width: 480,
    height: 360,
  };

  describe('normalizeAndValidateUrl', () => {
    it('chấp nhận URL hợp lệ thuộc allowlist', () => {
      const url = normalizeAndValidateUrl(
        'https://media.giphy.com/media/test/giphy.gif',
        ALLOWED_GIPHY_MEDIA_HOSTS,
        'displayUrl',
      );
      expect(url).toBe('https://media.giphy.com/media/test/giphy.gif');
    });

    it('chuẩn hóa hostname chữ hoa về chữ thường và bỏ trailing dot', () => {
      const url = normalizeAndValidateUrl(
        'https://MEDIA0.GIPHY.COM./media/test/giphy.gif',
        ALLOWED_GIPHY_MEDIA_HOSTS,
        'displayUrl',
      );
      expect(url).toBe('https://media0.giphy.com/media/test/giphy.gif');
    });

    it('từ chối URL sử dụng giao thức HTTP không an toàn', () => {
      expect(() =>
        normalizeAndValidateUrl(
          'http://media.giphy.com/media/test/giphy.gif',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);
    });

    it('chặn domain tấn công kết thúc bằng giphy.com (evilgiphy.com)', () => {
      expect(() =>
        normalizeAndValidateUrl(
          'https://evilgiphy.com/media/test/giphy.gif',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);
    });

    it('chặn domain subdomain giả mạo (giphy.com.attacker.com)', () => {
      expect(() =>
        normalizeAndValidateUrl(
          'https://giphy.com.attacker.com/media/test/giphy.gif',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);
    });

    it('chặn URL chứa thông tin xác thực credentials (user:pass@)', () => {
      expect(() =>
        normalizeAndValidateUrl(
          'https://user:password@media.giphy.com/media/test/giphy.gif',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);
    });

    it('chặn các scheme nguy hiểm (javascript:, data:, file:, blob:)', () => {
      expect(() =>
        normalizeAndValidateUrl(
          'javascript:alert(1)',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);

      expect(() =>
        normalizeAndValidateUrl(
          'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);
    });

    it('chặn IP address và localhost', () => {
      expect(() =>
        normalizeAndValidateUrl(
          'https://127.0.0.1/test.gif',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);

      expect(() =>
        normalizeAndValidateUrl(
          'https://localhost:443/test.gif',
          ALLOWED_GIPHY_MEDIA_HOSTS,
          'displayUrl',
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateAndSanitizeGiphyMedia', () => {
    it('validate thành công payload chuẩn từ GIPHY', () => {
      const sanitized = validateAndSanitizeGiphyMedia(validMediaPayload);
      expect(sanitized.provider).toBe('giphy');
      expect(sanitized.mediaType).toBe('gif');
      expect(sanitized.externalId).toBe('YQitOmg976101WnSYP');
      expect(sanitized.width).toBe(480);
      expect(sanitized.height).toBe(360);
      expect(sanitized.pageUrl).toBe('https://giphy.com/gifs/cat-dance-YQitOmg976101WnSYP');
    });

    it('chấp nhận width và height dạng string hợp lệ từ API', () => {
      const sanitized = validateAndSanitizeGiphyMedia({
        ...validMediaPayload,
        width: '480',
        height: '360',
      });
      expect(sanitized.width).toBe(480);
      expect(sanitized.height).toBe(360);
    });

    it('sanitize HTML tags trong title và creatorUsername', () => {
      const sanitized = validateAndSanitizeGiphyMedia({
        ...validMediaPayload,
        title: '<b>Happy</b> <script>alert(1)</script>Cat',
        creatorUsername: '<a href="evil">artist</a>',
      });
      expect(sanitized.title).toBe('Happy alert(1)Cat');
      expect(sanitized.creatorUsername).toBe('artist');
    });

    it('từ chối provider không phải giphy', () => {
      expect(() =>
        validateAndSanitizeGiphyMedia({
          ...validMediaPayload,
          provider: 'tenor',
        }),
      ).toThrow(BadRequestException);
    });

    it('từ chối externalId sai định dạng', () => {
      expect(() =>
        validateAndSanitizeGiphyMedia({
          ...validMediaPayload,
          externalId: 'id with spaces!@#$',
        }),
      ).toThrow(BadRequestException);
    });

    it('từ chối kích thước âm hoặc vượt quá 4096px', () => {
      expect(() =>
        validateAndSanitizeGiphyMedia({
          ...validMediaPayload,
          width: -10,
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        validateAndSanitizeGiphyMedia({
          ...validMediaPayload,
          height: 10000,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('Integration Fixtures từ Response GIPHY Thật', () => {
    it('chấp nhận tất cả media CDN subdomains media0..media4 và i.giphy.com', () => {
      const hosts = [
        'https://media.giphy.com/media/1/giphy.gif',
        'https://media0.giphy.com/media/1/giphy.gif',
        'https://media1.giphy.com/media/1/giphy.gif',
        'https://media2.giphy.com/media/1/giphy.gif',
        'https://media3.giphy.com/media/1/giphy.gif',
        'https://media4.giphy.com/media/1/giphy.gif',
        'https://i.giphy.com/media/1/giphy.gif',
      ];

      for (const url of hosts) {
        expect(() =>
          normalizeAndValidateUrl(url, ALLOWED_GIPHY_MEDIA_HOSTS, 'displayUrl'),
        ).not.toThrow();
      }
    });

    it('chấp nhận cả giphy.com và www.giphy.com cho pageUrl', () => {
      expect(() =>
        normalizeAndValidateUrl('https://giphy.com/gifs/1', ALLOWED_GIPHY_PAGE_HOSTS, 'pageUrl'),
      ).not.toThrow();
      expect(() =>
        normalizeAndValidateUrl('https://www.giphy.com/gifs/1', ALLOWED_GIPHY_PAGE_HOSTS, 'pageUrl'),
      ).not.toThrow();
    });
  });

  describe('Stipop Stickers Validation', () => {
    const validStipopPayload = {
      provider: 'stipop',
      externalId: '45268',
      mediaType: 'sticker',
      title: 'Happy Sticker',
      creatorUsername: 'amam',
      pageUrl: 'https://stipop.io/package/2199',
      previewUrl: 'https://img.stipop.io/sticker/2199/200t5ZzVZ9Ebx.png',
      displayUrl: 'https://img.stipop.io/2019/9/6/1567827398490_7.png',
      mp4Url: null,
      width: 300,
      height: 300,
    };

    it('chấp nhận Stipop sticker hợp lệ', () => {
      const sanitized = validateAndSanitizeGiphyMedia(validStipopPayload);
      expect(sanitized.provider).toBe('stipop');
      expect(sanitized.mediaType).toBe('sticker');
      expect(sanitized.externalId).toBe('45268');
      expect(sanitized.title).toBe('Happy Sticker');
      expect(sanitized.creatorUsername).toBe('amam');
      expect(sanitized.displayUrl).toBe('https://img.stipop.io/2019/9/6/1567827398490_7.png');
    });

    it('từ chối Stipop sticker có host lạ không nằm trong allowlist', () => {
      expect(() =>
        validateAndSanitizeGiphyMedia({
          ...validStipopPayload,
          displayUrl: 'https://evil-stipop.com/sticker.png',
        }),
      ).toThrow(BadRequestException);
    });
  });
});
