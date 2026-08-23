import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../../infra/supabase/supabase.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { FriendsModule } from '../friends/friends.module';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';

@Module({
  imports: [SupabaseModule, ConversationsModule, FriendsModule, ConfigModule],
  providers: [ChatGateway, PresenceService],
  exports: [ChatGateway, PresenceService],
})
export class RealtimeModule {}
