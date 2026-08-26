import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { GiphyMediaDto } from '../../shared/dto/messages.dto';
import {
  GiphySearchQueryDto,
  GiphyTrendingQueryDto,
} from './dto/giphy-query.dto';
import { GiphyService } from './giphy.service';

/**
 * Controller proxy cho các API tìm kiếm và lấy GIF từ GIPHY.
 * Toàn bộ request yêu cầu người dùng đã đăng nhập nhằm bảo vệ quota API key.
 */
@Controller('giphy')
@UseGuards(SupabaseAuthGuard)
export class GiphyController {
  constructor(private readonly giphyService: GiphyService) {}

  /**
   * GET /api/giphy/trending?limit=24&offset=0
   */
  @Get('trending')
  getTrending(@Query() query: GiphyTrendingQueryDto): Promise<GiphyMediaDto[]> {
    return this.giphyService.getTrending(query.limit, query.offset);
  }

  /**
   * GET /api/giphy/search?q=mèo&limit=24&offset=0
   */
  @Get('search')
  search(@Query() query: GiphySearchQueryDto): Promise<GiphyMediaDto[]> {
    return this.giphyService.search(query.q, query.limit, query.offset);
  }
}
