import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/** Global để mọi module dùng chung một client, không phải import lặp lại. */
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
