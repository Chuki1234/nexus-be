import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GiphyMediaDto } from '../../shared/dto/messages.dto';

interface GiphyRawImage {
  url?: string;
  width?: string;
  height?: string;
  webp?: string;
  mp4?: string;
}

interface GiphyRawItem {
  id: string;
  title?: string;
  url?: string;
  username?: string;
  user?: {
    username?: string;
    display_name?: string;
  };
  images?: {
    original?: GiphyRawImage;
    fixed_width?: GiphyRawImage;
    downsized_medium?: GiphyRawImage;
  };
}

interface GiphyApiResponse {
  data?: GiphyRawItem[];
  pagination?: {
    total_count: number;
    count: number;
    offset: number;
  };
  meta?: {
    status: number;
    msg: string;
  };
}

interface CacheEntry {
  data: GiphyMediaDto[];
  expiresAt: number;
}

@Injectable()
export class GiphyService {
  private readonly logger = new Logger(GiphyService.name);
  private readonly apiKey: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút

  constructor(private readonly configService: ConfigService) {
    this.apiKey =
      this.configService.get<string>('GIPHY_API_KEY')?.trim() ||
      process.env.GIPHY_API_KEY?.trim() ||
      '';

    if (!this.apiKey) {
      this.logger.warn(
        'GIPHY_API_KEY chưa được cấu hình. Các endpoint /api/giphy sẽ trả về lỗi.',
      );
    }
  }

  /**
   * Lấy danh sách GIF thịnh hành (Trending).
   */
  async getTrending(limit = 24, offset = 0): Promise<GiphyMediaDto[]> {
    const cacheKey = `trending_${limit}_${offset}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    this.ensureApiKeyConfigured();

    const url = new URL('https://api.giphy.com/v1/gifs/trending');
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('rating', 'g');

    const result = await this.fetchAndMap(url.toString());
    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Tìm kiếm GIF theo từ khóa.
   */
  async search(
    query: string,
    limit = 24,
    offset = 0,
  ): Promise<GiphyMediaDto[]> {
    const trimmed = query?.trim() || '';
    if (!trimmed) {
      return this.getTrending(limit, offset);
    }

    const cacheKey = `search_${trimmed.toLowerCase()}_${limit}_${offset}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    this.ensureApiKeyConfigured();

    const url = new URL('https://api.giphy.com/v1/gifs/search');
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('rating', 'g');
    url.searchParams.set('lang', 'vi');

    const result = await this.fetchAndMap(url.toString());
    this.setCache(cacheKey, result);
    return result;
  }

  private ensureApiKeyConfigured(): void {
    if (!this.apiKey || this.apiKey === 'GIPHY_API_KEY_PLACEHOLDER') {
      throw new ServiceUnavailableException(
        'GIPHY_API_KEY chưa được cấu hình trên máy chủ.',
      );
    }
  }

  private async fetchAndMap(apiUrl: string): Promise<GiphyMediaDto[]> {
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.logger.error(
          `Lỗi gọi GIPHY API [${response.status}]: ${errorText}`,
        );
        throw new InternalServerErrorException(
          `GIPHY API trả về lỗi (${response.status}).`,
        );
      }

      const json = (await response.json()) as GiphyApiResponse;
      return this.mapGiphyResponseToDtos(json);
    } catch (err: any) {
      if (
        err instanceof ServiceUnavailableException ||
        err instanceof InternalServerErrorException
      ) {
        throw err;
      }
      this.logger.error(`Không thể kết nối đến GIPHY API: ${err.message}`, err.stack);
      throw new InternalServerErrorException(
        'Không thể kết nối đến máy chủ GIPHY.',
      );
    }
  }

  /**
   * Chuyển đổi payload thô từ GIPHY API sang danh sách GiphyMediaDto chuẩn hóa.
   */
  mapGiphyResponseToDtos(res: GiphyApiResponse): GiphyMediaDto[] {
    if (!res || !Array.isArray(res.data)) {
      return [];
    }

    const results: GiphyMediaDto[] = [];
    for (const item of res.data) {
      if (!item || !item.id) continue;

      const original = item.images?.original;
      const fixedWidth = item.images?.fixed_width;
      const downsized = item.images?.downsized_medium;

      const displayUrl =
        original?.url || downsized?.url || fixedWidth?.url || null;
      const previewUrl =
        fixedWidth?.webp ||
        fixedWidth?.url ||
        original?.webp ||
        original?.url ||
        displayUrl;
      const mp4Url = fixedWidth?.mp4 || original?.mp4 || null;
      const pageUrl = item.url || `https://giphy.com/gifs/${item.id}`;

      if (!displayUrl || !previewUrl) {
        continue;
      }

      let width = 480;
      let height = 360;

      if (original?.width && original?.height) {
        const parsedW = parseInt(original.width, 10);
        const parsedH = parseInt(original.height, 10);
        if (!isNaN(parsedW) && !isNaN(parsedH) && parsedW > 0 && parsedH > 0) {
          width = Math.min(parsedW, 4096);
          height = Math.min(parsedH, 4096);
        }
      } else if (fixedWidth?.width && fixedWidth?.height) {
        const parsedW = parseInt(fixedWidth.width, 10);
        const parsedH = parseInt(fixedWidth.height, 10);
        if (!isNaN(parsedW) && !isNaN(parsedH) && parsedW > 0 && parsedH > 0) {
          width = Math.min(parsedW, 4096);
          height = Math.min(parsedH, 4096);
        }
      }

      const dto: GiphyMediaDto = {
        provider: 'giphy',
        externalId: item.id,
        mediaType: 'gif',
        title: (item.title?.trim() || 'GIF').slice(0, 255),
        creatorUsername:
          (item.username || item.user?.username || null)?.slice(0, 100) || null,
        pageUrl,
        previewUrl,
        displayUrl,
        mp4Url,
        width,
        height,
      };

      results.push(dto);
    }

    return results;
  }

  private getFromCache(key: string): GiphyMediaDto[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setCache(key: string, data: GiphyMediaDto[]): void {
    // Giữ kích thước cache tối đa 200 items để tiết kiệm RAM
    if (this.cache.size > 200) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });
  }
}
