import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../infra/supabase/supabase.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

@Module({
  imports: [SupabaseModule, ConversationsModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
