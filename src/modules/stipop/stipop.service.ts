import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalMediaDto } from '../../shared/dto/messages.dto';

export interface StipopPackageSummary {
  packageId: number;
  packageName: string;
  packageImg: string;
  artistName: string;
  isAnimated: boolean;
}

export interface StipopPackageDetail extends StipopPackageSummary {
  stickers: ExternalMediaDto[];
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

@Injectable()
export class StipopService {
  private readonly logger = new Logger(StipopService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://messenger.stipop.io/v1';
  private readonly cache = new Map<string, CacheEntry<any>>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút

  constructor(private readonly configService: ConfigService) {
    this.apiKey =
      this.configService.get<string>('STIPOP_API_KEY')?.trim() ||
      process.env.STIPOP_API_KEY?.trim() ||
      '';

    if (!this.apiKey) {
      this.logger.warn(
        'STIPOP_API_KEY chưa được cấu hình. Các endpoint /api/stipop sẽ trả về lỗi.',
      );
    }
  }

  private ensureApiKeyConfigured(): void {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Tính năng Sticker Stipop chưa được kích hoạt do thiếu API key.',
      );
    }
  }

  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });
  }

  /**
   * Helper ánh xạ sticker thô từ Stipop sang ExternalMediaDto chuẩn
   */
  mapStickerToDto(raw: any, packageName?: string): ExternalMediaDto {
    const stickerId = String(raw.stickerId || raw.id || '');
    const displayUrl = raw.stickerImg || raw.stickerImg_300 || raw.stickerImg_408 || '';
    const previewUrl = raw.stickerImg_200 || raw.stickerImg_300 || raw.stickerImg_96 || displayUrl;
    const title = raw.keyword || packageName || raw.artistName || 'Sticker';
    const packageId = raw.packageId ? String(raw.packageId) : '';

    return {
      provider: 'stipop',
      externalId: stickerId,
      mediaType: 'sticker',
      title,
      creatorUsername: raw.artistName || null,
      pageUrl: packageId ? `https://stipop.io/package/${packageId}` : 'https://stipop.io',
      previewUrl,
      displayUrl,
      mp4Url: null,
      width: 300,
      height: 300,
    };
  }

  /**
   * Lấy danh sách gói sticker thịnh hành (Trending Packs)
   */
  async getTrendingPackages(
    userId: string,
    pageNumber = 1,
    limit = 20,
  ): Promise<StipopPackageSummary[]> {
    const cacheKey = `trending_pkgs_${userId}_${pageNumber}_${limit}`;
    const cached = this.getFromCache<StipopPackageSummary[]>(cacheKey);
    if (cached) return cached;

    this.ensureApiKeyConfigured();

    const url = new URL(`${this.baseUrl}/package`);
    url.searchParams.set('userId', userId);
    url.searchParams.set('pageNumber', pageNumber.toString());
    url.searchParams.set('limit', limit.toString());

    try {
      const res = await fetch(url.toString(), {
        headers: { apikey: this.apiKey },
      });

      if (!res.ok) {
        throw new Error(`Stipop API HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      const list = json?.body?.packageList || [];

      const packages: StipopPackageSummary[] = list.map((pkg: any) => ({
        packageId: pkg.packageId,
        packageName: pkg.packageName || 'Sticker Pack',
        packageImg: pkg.packageImg || pkg.packageImg_45 || '',
        artistName: pkg.artistName || '',
        isAnimated: pkg.packageAnimated === 'Y',
      }));

      this.setCache(cacheKey, packages);
      return packages;
    } catch (err: unknown) {
      this.logger.error('Lỗi gọi Stipop trending packages:', err);
      throw new InternalServerErrorException('Không thể tải danh sách sticker thịnh hành.');
    }
  }

  /**
   * Lấy chi tiết gói sticker và toàn bộ sticker trong gói
   */
  async getPackageDetail(
    userId: string,
    packageId: number | string,
  ): Promise<StipopPackageDetail> {
    const cacheKey = `package_${userId}_${packageId}`;
    const cached = this.getFromCache<StipopPackageDetail>(cacheKey);
    if (cached) return cached;

    this.ensureApiKeyConfigured();

    const url = new URL(`${this.baseUrl}/package/${packageId}`);
    url.searchParams.set('userId', userId);

    try {
      const res = await fetch(url.toString(), {
        headers: { apikey: this.apiKey },
      });

      if (!res.ok) {
        throw new Error(`Stipop API HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      const pkg = json?.body?.package || {};
      const rawStickers = pkg.stickers || [];

      const stickers: ExternalMediaDto[] = rawStickers.map((s: any) =>
        this.mapStickerToDto(s, pkg.packageName),
      );

      const detail: StipopPackageDetail = {
        packageId: Number(pkg.packageId || packageId),
        packageName: pkg.packageName || 'Sticker Pack',
        packageImg: pkg.packageImg || '',
        artistName: pkg.artistName || '',
        isAnimated: pkg.packageAnimated === 'Y',
        stickers,
      };

      this.setCache(cacheKey, detail);
      return detail;
    } catch (err: unknown) {
      this.logger.error(`Lỗi tải gói sticker ${packageId}:`, err);
      throw new InternalServerErrorException('Không thể tải nội dung gói sticker.');
    }
  }

  /**
   * Tìm kiếm stickers theo từ khóa
   */
  async searchStickers(
    userId: string,
    query: string,
    pageNumber = 1,
    limit = 30,
    lang = 'vi',
  ): Promise<ExternalMediaDto[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      // Khi không có từ khoá, lấy stickers từ gói đầu tiên
      const trendingPkgs = await this.getTrendingPackages(userId, 1, 1);
      if (trendingPkgs.length > 0) {
        const detail = await this.getPackageDetail(userId, trendingPkgs[0].packageId);
        return detail.stickers;
      }
      return [];
    }

    const cacheKey = `search_${userId}_${trimmed.toLowerCase()}_${pageNumber}_${limit}_${lang}`;
    const cached = this.getFromCache<ExternalMediaDto[]>(cacheKey);
    if (cached) return cached;

    this.ensureApiKeyConfigured();

    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('userId', userId);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('pageNumber', pageNumber.toString());
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('lang', lang);

    try {
      const res = await fetch(url.toString(), {
        headers: { apikey: this.apiKey },
      });

      if (!res.ok) {
        throw new Error(`Stipop API HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      const list = json?.body?.stickerList || [];

      const stickers: ExternalMediaDto[] = list.map((s: any) =>
        this.mapStickerToDto(s),
      );

      this.setCache(cacheKey, stickers);
      return stickers;
    } catch (err: unknown) {
      this.logger.error('Lỗi tìm kiếm sticker Stipop:', err);
      throw new InternalServerErrorException('Không thể tìm kiếm sticker.');
    }
  }

  /**
   * Lấy danh sách từ khoá gợi ý
   */
  async getSuggestions(userId: string, lang = 'vi'): Promise<string[]> {
    const cacheKey = `suggest_${userId}_${lang}`;
    const cached = this.getFromCache<string[]>(cacheKey);
    if (cached) return cached;

    this.ensureApiKeyConfigured();

    const url = new URL(`${this.baseUrl}/search/keyword`);
    url.searchParams.set('userId', userId);
    url.searchParams.set('lang', lang);

    try {
      const res = await fetch(url.toString(), {
        headers: { apikey: this.apiKey },
      });

      if (!res.ok) {
        throw new Error(`Stipop API HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      const list = json?.body?.keywordList || [];
      const keywords: string[] = list.map((k: any) => String(k.keyword || '')).filter(Boolean);

      this.setCache(cacheKey, keywords);
      return keywords;
    } catch (err: unknown) {
      this.logger.warn('Lỗi lấy từ khóa gợi ý Stipop:', err);
      return ['happy', 'love', 'cute', 'cat', 'dance', 'sad'];
    }
  }
}
