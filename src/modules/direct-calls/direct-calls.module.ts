import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../../infra/supabase/supabase.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { DirectCallsController } from './direct-calls.controller';
import { DirectCallsService } from './direct-calls.service';
import { DirectCallTokenService } from './direct-call-token.service';
import { DirectCallExpiryWorker } from './direct-call-expiry.worker';
import { DirectCallCleanupWorker } from './direct-call-cleanup.worker';

@Module({
  imports: [
    ConfigModule,
    SupabaseModule,
    forwardRef(() => RealtimeModule),
  ],
  controllers: [DirectCallsController],
  providers: [
    DirectCallsService,
    DirectCallTokenService,
    DirectCallExpiryWorker,
    DirectCallCleanupWorker,
  ],
  exports: [DirectCallsService, DirectCallTokenService],
})
export class DirectCallsModule {}
