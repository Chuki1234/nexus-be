import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../infra/supabase/supabase.module';
import { GiphyController } from './giphy.controller';
import { GiphyService } from './giphy.service';

@Module({
  imports: [SupabaseModule],
  controllers: [GiphyController],
  providers: [GiphyService],
  exports: [GiphyService],
})
export class GiphyModule {}
