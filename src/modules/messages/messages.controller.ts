import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { EditMessageDto } from './dto/edit-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import type {
  MessageResponseDto,
  MessagesPaginationResponseDto,
} from './dto/message-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagesService } from './messages.service';

@Controller('api')
@UseGuards(SupabaseAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  /**
   * Tải lịch sử tin nhắn trong cuộc trò chuyện (cursor pagination).
   */
  @Get('conversations/:conversationId/messages')
  async getConversationMessages(
    @CurrentUser() user: User,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: GetMessagesQueryDto,
  ): Promise<MessagesPaginationResponseDto> {
    return this.messagesService.getConversationMessages(
      user.id,
      conversationId,
      query,
    );
  }

  /**
   * Gửi tin nhắn mới vào cuộc trò chuyện.
   */
  @Post('conversations/:conversationId/messages')
  async sendConversationMessage(
    @CurrentUser() user: User,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.createConversationMessage(
      user.id,
      conversationId,
      dto,
    );
  }

  /**
   * Chỉnh sửa tin nhắn của chính mình.
   */
  @Patch('messages/:id')
  async editMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: EditMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.editMessage(user.id, id, dto);
  }

  /**
   * Xoá tin nhắn của chính mình (soft delete).
   */
  @Delete('messages/:id')
  async deleteMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ id: string; deleted: boolean }> {
    return this.messagesService.deleteMessage(user.id, id);
  }

  /**
   * Đánh dấu đã đọc tin nhắn trong cuộc trò chuyện.
   */
  @Post('conversations/:conversationId/read')
  async markAsRead(
    @CurrentUser() user: User,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body('messageId') messageId: string,
  ): Promise<{ success: boolean }> {
    return this.messagesService.markAsRead(user.id, conversationId, messageId);
  }
}
