import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../../infra/supabase/supabase.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ChatGateway } from './chat.gateway';

@Module({
  imports: [SupabaseModule, ConversationsModule, ConfigModule],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class RealtimeModule {}
