import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../../infra/supabase/supabase.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { FriendsModule } from '../friends/friends.module';
import { ServersModule } from '../servers/servers.module';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';
import { RedisStateService } from './redis-state.service';

@Module({
  imports: [
    SupabaseModule,
    ConversationsModule,
    FriendsModule,
    ConfigModule,
    forwardRef(() => ServersModule),
  ],
  providers: [ChatGateway, PresenceService, RedisStateService],
  exports: [ChatGateway, PresenceService, RedisStateService],
})
export class RealtimeModule {}
