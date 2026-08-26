import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { StipopController } from './stipop.controller';
import { StipopService } from './stipop.service';

describe('StipopController', () => {
  let controller: StipopController;
  const user = { id: 'user-1' } as any;

  const mockStipopService = {
    getTrendingPackages: jest.fn().mockResolvedValue([
      {
        packageId: 22912,
        packageName: 'Butler and Cats',
        packageImg: 'https://img.stipop.io/pkg.gif',
        artistName: 'JUHEEYU',
        isAnimated: true,
      },
    ]),
    searchStickers: jest.fn().mockResolvedValue([
      {
        provider: 'stipop',
        externalId: '45268',
        mediaType: 'sticker',
        title: 'happy',
        creatorUsername: 'amam',
        pageUrl: 'https://stipop.io/package/2199',
        previewUrl: 'https://img.stipop.io/preview.png',
        displayUrl: 'https://img.stipop.io/display.png',
        mp4Url: null,
        width: 300,
        height: 300,
      },
    ]),
    getPackageDetail: jest.fn().mockResolvedValue({
      packageId: 22912,
      packageName: 'Butler and Cats',
      packageImg: 'https://img.stipop.io/pkg.gif',
      artistName: 'JUHEEYU',
      isAnimated: true,
      stickers: [],
    }),
    getSuggestions: jest.fn().mockResolvedValue(['happy', 'love']),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StipopController],
      providers: [{ provide: StipopService, useValue: mockStipopService }],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<StipopController>(StipopController);
  });

  it('gọi getTrendingPackages khi gọi GET /trending', async () => {
    const res = await controller.getTrending(user, '1', '20');
    expect(res.length).toBe(1);
    expect(mockStipopService.getTrendingPackages).toHaveBeenCalledWith('user-1', 1, 20);
  });

  it('gọi searchStickers khi gọi GET /search', async () => {
    const res = await controller.search(user, 'cat', '1', '30', 'vi');
    expect(res.length).toBe(1);
    expect(mockStipopService.searchStickers).toHaveBeenCalledWith(
      'user-1',
      'cat',
      1,
      30,
      'vi',
    );
  });

  it('gọi getPackageDetail khi gọi GET /package/:packageId', async () => {
    const res = await controller.getPackage(user, '22912');
    expect(res.packageName).toBe('Butler and Cats');
    expect(mockStipopService.getPackageDetail).toHaveBeenCalledWith('user-1', '22912');
  });

  it('gọi getSuggestions khi gọi GET /suggest', async () => {
    const res = await controller.getSuggestions(user, 'vi');
    expect(res).toEqual(['happy', 'love']);
    expect(mockStipopService.getSuggestions).toHaveBeenCalledWith('user-1', 'vi');
  });
});
