import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ExternalMediaDto } from '../../shared/dto/messages.dto';
import {
  StipopPackageDetail,
  StipopPackageSummary,
  StipopService,
} from './stipop.service';

@Controller('stipop')
@UseGuards(SupabaseAuthGuard)
export class StipopController {
  constructor(private readonly stipopService: StipopService) {}

  /**
   * GET /api/stipop/trending?pageNumber=1&limit=20
   */
  @Get('trending')
  getTrending(
    @CurrentUser() user: User,
    @Query('pageNumber') pageNumber?: string,
    @Query('limit') limit?: string,
  ): Promise<StipopPackageSummary[]> {
    const page = Math.max(1, parseInt(pageNumber || '1', 10) || 1);
    const lim = Math.min(50, Math.max(1, parseInt(limit || '20', 10) || 20));
    return this.stipopService.getTrendingPackages(user.id, page, lim);
  }

  /**
   * GET /api/stipop/search?q=cat&pageNumber=1&limit=30&lang=vi
   */
  @Get('search')
  search(
    @CurrentUser() user: User,
    @Query('q') query?: string,
    @Query('pageNumber') pageNumber?: string,
    @Query('limit') limit?: string,
    @Query('lang') lang?: string,
  ): Promise<ExternalMediaDto[]> {
    const page = Math.max(1, parseInt(pageNumber || '1', 10) || 1);
    const lim = Math.min(50, Math.max(1, parseInt(limit || '30', 10) || 30));
    return this.stipopService.searchStickers(
      user.id,
      query || '',
      page,
      lim,
      lang || 'vi',
    );
  }

  /**
   * GET /api/stipop/package/:packageId
   */
  @Get('package/:packageId')
  getPackage(
    @CurrentUser() user: User,
    @Param('packageId') packageId: string,
  ): Promise<StipopPackageDetail> {
    return this.stipopService.getPackageDetail(user.id, packageId);
  }

  /**
   * GET /api/stipop/suggest?lang=vi
   */
  @Get('suggest')
  getSuggestions(
    @CurrentUser() user: User,
    @Query('lang') lang?: string,
  ): Promise<string[]> {
    return this.stipopService.getSuggestions(user.id, lang || 'vi');
  }
}
