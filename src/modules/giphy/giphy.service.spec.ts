import { InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { GiphyService } from './giphy.service';

describe('GiphyService', () => {
  let service: GiphyService;
  let configService: ConfigService;

  const mockGiphyApiResponse = {
    data: [
      {
        id: 'gif123',
        title: 'Happy Dance Cat GIF',
        url: 'https://giphy.com/gifs/happy-dance-cat-gif123',
        username: 'catdancer',
        images: {
          original: {
            url: 'https://media0.giphy.com/media/gif123/giphy.gif',
            width: '480',
            height: '360',
            mp4: 'https://media1.giphy.com/media/gif123/giphy.mp4',
            webp: 'https://media0.giphy.com/media/gif123/giphy.webp',
          },
          fixed_width: {
            url: 'https://media0.giphy.com/media/gif123/200w.gif',
            width: '200',
            height: '150',
            mp4: 'https://media1.giphy.com/media/gif123/200w.mp4',
            webp: 'https://media0.giphy.com/media/gif123/200w.webp',
          },
        },
      },
    ],
    pagination: { total_count: 1, count: 1, offset: 0 },
    meta: { status: 200, msg: 'OK' },
  };

  const createServiceWithKey = async (apiKey: string) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GiphyService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'GIPHY_API_KEY') return apiKey;
              return null;
            }),
          },
        },
      ],
    }).compile();

    return module.get<GiphyService>(GiphyService);
  };

  beforeEach(async () => {
    service = await createServiceWithKey('valid_test_api_key');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('mapGiphyResponseToDtos', () => {
    it('chuyển đổi payload chuẩn thành GiphyMediaDto đầy đủ', () => {
      const dtos = service.mapGiphyResponseToDtos(mockGiphyApiResponse);
      expect(dtos).toHaveLength(1);

      const item = dtos[0];
      expect(item.provider).toBe('giphy');
      expect(item.externalId).toBe('gif123');
      expect(item.mediaType).toBe('gif');
      expect(item.title).toBe('Happy Dance Cat GIF');
      expect(item.creatorUsername).toBe('catdancer');
      expect(item.width).toBe(480);
      expect(item.height).toBe(360);
      expect(item.displayUrl).toBe('https://media0.giphy.com/media/gif123/giphy.gif');
      expect(item.previewUrl).toBe('https://media0.giphy.com/media/gif123/200w.webp');
      expect(item.mp4Url).toBe('https://media1.giphy.com/media/gif123/200w.mp4');
    });

    it('fallback giá trị an toàn khi metadata thiếu hoặc kích thước không hợp lệ', () => {
      const malformedResponse = {
        data: [
          {
            id: 'corrupted1',
            title: '',
            images: {
              original: {
                url: 'https://media.giphy.com/media/corrupted1/giphy.gif',
                width: 'invalid',
                height: 'NaN',
              },
            },
          },
          {
            id: 'missingUrls',
            images: {},
          },
        ],
      };

      const dtos = service.mapGiphyResponseToDtos(malformedResponse as any);
      expect(dtos).toHaveLength(1);
      expect(dtos[0].externalId).toBe('corrupted1');
      expect(dtos[0].title).toBe('GIF');
      expect(dtos[0].width).toBe(480);
      expect(dtos[0].height).toBe(360);
    });
  });

  describe('getTrending và search', () => {
    it('ném ServiceUnavailableException nếu chưa cấu hình API key', async () => {
      const serviceNoKey = await createServiceWithKey('');
      await expect(serviceNoKey.getTrending()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('gọi fetch đúng endpoint trending và cache kết quả', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockGiphyApiResponse,
      } as any);

      const res1 = await service.getTrending(24, 0);
      expect(res1).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Gọi lần 2 phải lấy từ cache mà không gọi fetch lại
      const res2 = await service.getTrending(24, 0);
      expect(res2).toEqual(res1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('gọi fetch đúng endpoint search với từ khóa tiếng Việt', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockGiphyApiResponse,
      } as any);

      const res = await service.search('mèo vui nhộn', 20, 0);
      expect(res).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = new URL(fetchSpy.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/v1/gifs/search');
      expect(url.searchParams.get('q')).toBe('mèo vui nhộn');
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('lang')).toBe('vi');
    });

    it('ném InternalServerErrorException khi máy chủ GIPHY trả về mã lỗi HTTP', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      } as any);

      await expect(service.getTrending()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
