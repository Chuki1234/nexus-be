import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { GiphyController } from './giphy.controller';
import { GiphyService } from './giphy.service';

describe('GiphyController', () => {
  let controller: GiphyController;
  let service: GiphyService;

  const mockMedia = [
    {
      provider: 'giphy' as const,
      externalId: 'test1234',
      mediaType: 'gif' as const,
      title: 'Test GIF',
      creatorUsername: null,
      pageUrl: 'https://giphy.com/gifs/test1234',
      previewUrl: 'https://media.giphy.com/media/test1234/200w.webp',
      displayUrl: 'https://media.giphy.com/media/test1234/giphy.gif',
      mp4Url: null,
      width: 480,
      height: 360,
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GiphyController],
      providers: [
        {
          provide: GiphyService,
          useValue: {
            getTrending: jest.fn().mockResolvedValue(mockMedia),
            search: jest.fn().mockResolvedValue(mockMedia),
          },
        },
        {
          provide: SupabaseService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<GiphyController>(GiphyController);
    service = module.get<GiphyService>(GiphyService);
  });

  it('trending gọi service.getTrending với params tương ứng', async () => {
    const result = await controller.getTrending({ limit: 10, offset: 0 });
    expect(result).toEqual(mockMedia);
    expect(service.getTrending).toHaveBeenCalledWith(10, 0);
  });

  it('search gọi service.search với query, limit và offset', async () => {
    const result = await controller.search({ q: 'cat', limit: 15, offset: 5 });
    expect(result).toEqual(mockMedia);
    expect(service.search).toHaveBeenCalledWith('cat', 15, 5);
  });
});
