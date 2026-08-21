import { Module } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { StorageModule } from '../../infra/storage/storage.module';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [StorageModule],
  controllers: [ProfilesController],
  providers: [ProfilesService, SupabaseAuthGuard],
})
export class ProfilesModule {}
