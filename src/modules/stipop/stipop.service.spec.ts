import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { StipopService } from './stipop.service';

describe('StipopService', () => {
  let service: StipopService;

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'STIPOP_API_KEY') return 'test-stipop-api-key';
      return null;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StipopService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<StipopService>(StipopService);
  });

  it('mapStickerToDto ánh xạ đúng định dạng ExternalMediaDto', () => {
    const raw = {
      stickerId: 45268,
      packageId: 2199,
      artistName: 'amam',
      keyword: 'happy',
      stickerImg: 'https://img.stipop.io/2019/9/6/1567827398490_7.png',
      stickerImg_300: 'https://img.stipop.io/sticker/2199/300t5ZzVZ9Ebx.png',
      stickerImg_200: 'https://img.stipop.io/sticker/2199/200t5ZzVZ9Ebx.png',
    };

    const dto = service.mapStickerToDto(raw);

    expect(dto.provider).toBe('stipop');
    expect(dto.mediaType).toBe('sticker');
    expect(dto.externalId).toBe('45268');
    expect(dto.title).toBe('happy');
    expect(dto.creatorUsername).toBe('amam');
    expect(dto.displayUrl).toBe('https://img.stipop.io/2019/9/6/1567827398490_7.png');
    expect(dto.previewUrl).toBe('https://img.stipop.io/sticker/2199/200t5ZzVZ9Ebx.png');
    expect(dto.pageUrl).toBe('https://stipop.io/package/2199');
  });

  it('searchStickers gọi Stipop search endpoint và cache kết quả', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        body: {
          stickerList: [
            {
              stickerId: 45268,
              packageId: 2199,
              artistName: 'amam',
              keyword: 'happy',
              stickerImg: 'https://img.stipop.io/2019/9/6/1567827398490_7.png',
            },
          ],
        },
      }),
    } as any);

    const result = await service.searchStickers('user-1', 'happy', 1, 20);
    expect(result.length).toBe(1);
    expect(result[0].externalId).toBe('45268');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Lần gọi thứ 2 với cùng tham số -> lấy từ cache, không fetch lại
    const cachedResult = await service.searchStickers('user-1', 'happy', 1, 20);
    expect(cachedResult.length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
