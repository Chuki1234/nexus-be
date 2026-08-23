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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ParsePositiveBigIntPipe } from '../../common/pipes/parse-positive-bigint.pipe';
import { EditMessageDto } from './dto/edit-message.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import type {
  MessageResponseDto,
  MessagesPaginationResponseDto,
} from './dto/message-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SetReactionDto } from './dto/set-reaction.dto';
import { MessagesService, type SetReactionResponseDto } from './messages.service';

@Controller()
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
   * Gửi tin nhắn mới vào cuộc trò chuyện (hỗ trợ text và tối đa 5 files đính kèm).
   */
  @Post('conversations/:conversationId/messages')
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
    }),
  )
  async sendConversationMessage(
    @CurrentUser() user: User,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<MessageResponseDto> {
    return this.messagesService.createConversationMessage(
      user.id,
      conversationId,
      dto,
      files,
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
   * Tải lại signed URL mới cho attachment khi URL cũ hết hạn (401/403).
   */
  @Get('conversations/:conversationId/attachments/:attachmentId/signed-url')
  async getAttachmentSignedUrl(
    @CurrentUser() user: User,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ signedUrl: string }> {
    return this.messagesService.getAttachmentSignedUrl(
      user.id,
      conversationId,
      attachmentId,
    );
  }

  /**
   * Thêm hoặc xóa reaction cho tin nhắn theo desired state (Idempotent).
   */
  @Post('conversations/:conversationId/messages/:messageId/reactions')
  async setReaction(
    @CurrentUser() user: User,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) conversationId: string,
    @Param('messageId', ParsePositiveBigIntPipe) messageId: string,
    @Body() dto: SetReactionDto,
  ): Promise<SetReactionResponseDto> {
    return this.messagesService.setReaction(
      user.id,
      conversationId,
      messageId,
      dto,
    );
  }

  /**
   * Chuyển tiếp tin nhắn (text + attachments) sang cuộc trò chuyện đích (Compensating Workflow & Idempotent).
   */
  @Post('conversations/:conversationId/messages/:messageId/forward')
  async forwardConversationMessage(
    @CurrentUser() user: User,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) conversationId: string,
    @Param('messageId', ParsePositiveBigIntPipe) messageId: string,
    @Body() dto: ForwardMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.forwardConversationMessage(
      user.id,
      conversationId,
      messageId,
      dto,
    );
  }

  /**
   * Đánh dấu đã đọc tin nhắn trong cuộc trò chuyện.
   */
  @Post('conversations/:conversationId/read')
  async markAsRead(
    @CurrentUser() user: User,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: MarkReadDto,
  ): Promise<{ success: boolean }> {
    return this.messagesService.markAsRead(
      user.id,
      conversationId,
      dto.messageId,
    );
  }
}
