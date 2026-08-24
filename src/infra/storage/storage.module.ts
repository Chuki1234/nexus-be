import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { StorageCleanupWorker } from './storage-cleanup.worker';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  providers: [MediaService, StorageCleanupWorker],
  exports: [MediaService, StorageCleanupWorker],
})
export class StorageModule {}
