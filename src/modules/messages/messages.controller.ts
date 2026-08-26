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
import { DeleteMessageQueryDto, DeleteMessageScope } from './dto/delete-message.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import type {
  ChannelMessagesResponseDto,
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

  // ---------------------------------------------------------------------------
  // Conversation (Live DM) Endpoints
  // ---------------------------------------------------------------------------

  @Get('conversations/:id/messages')
  async getConversationMessages(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GetMessagesQueryDto,
  ): Promise<MessagesPaginationResponseDto> {
    return this.messagesService.getConversationMessages(user.id, id, query);
  }

  @Post('conversations/:id/messages')
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
    }),
  )
  async sendConversationMessage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<MessageResponseDto> {
    return this.messagesService.createConversationMessage(
      user.id,
      id,
      dto,
      files,
    );
  }

  /**
   * Tải lại signed URL mới cho attachment khi URL cũ hết hạn (401/403) trong DM.
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
   * Thêm hoặc xóa reaction cho tin nhắn trong DM (Idempotent).
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
   * Chuyển tiếp tin nhắn từ cuộc trò chuyện.
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

  // ---------------------------------------------------------------------------
  // Server Channel Endpoints
  // ---------------------------------------------------------------------------

  /**
   * Tải lịch sử tin nhắn trong kênh máy chủ (cursor pagination + lastReadMessageId).
   */
  @Get('channels/:channelId/messages')
  async getChannelMessages(
    @CurrentUser() user: User,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query() query: GetMessagesQueryDto,
  ): Promise<ChannelMessagesResponseDto> {
    return this.messagesService.getChannelMessages(
      user.id,
      channelId,
      query,
    );
  }

  /**
   * Gửi tin nhắn mới vào kênh máy chủ (hỗ trợ text và tối đa 5 files đính kèm).
   */
  @Post('channels/:channelId/messages')
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
    }),
  )
  async sendChannelMessage(
    @CurrentUser() user: User,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() dto: SendMessageDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<MessageResponseDto> {
    return this.messagesService.createChannelMessage(
      user.id,
      channelId,
      dto,
      files,
    );
  }

  /**
   * Tải lại signed URL mới cho attachment khi URL cũ hết hạn trong kênh máy chủ.
   */
  @Get('channels/:channelId/attachments/:attachmentId/signed-url')
  async getChannelAttachmentSignedUrl(
    @CurrentUser() user: User,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<{ signedUrl: string }> {
    return this.messagesService.getChannelAttachmentSignedUrl(
      user.id,
      channelId,
      attachmentId,
    );
  }

  /**
   * Thêm hoặc xóa reaction cho tin nhắn trong kênh máy chủ.
   */
  @Post('channels/:channelId/messages/:messageId/reactions')
  async setChannelReaction(
    @CurrentUser() user: User,
    @Param('channelId', new ParseUUIDPipe({ version: '4' })) channelId: string,
    @Param('messageId', ParsePositiveBigIntPipe) messageId: string,
    @Body() dto: SetReactionDto,
  ): Promise<SetReactionResponseDto> {
    return this.messagesService.setChannelReaction(
      user.id,
      channelId,
      messageId,
      dto,
    );
  }

  /**
   * Đánh dấu đã đọc tin nhắn trong kênh máy chủ.
   */
  @Post('channels/:channelId/read')
  async markChannelAsRead(
    @CurrentUser() user: User,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() dto: MarkReadDto,
  ): Promise<{ success: boolean; updated?: boolean; lastReadMessageId?: string }> {
    return this.messagesService.markChannelAsRead(
      user.id,
      channelId,
      dto.messageId,
    );
  }

  /**
   * Chuyển tiếp tin nhắn từ kênh máy chủ.
   */
  @Post('channels/:channelId/messages/:messageId/forward')
  async forwardChannelMessage(
    @CurrentUser() user: User,
    @Param('channelId', new ParseUUIDPipe({ version: '4' })) channelId: string,
    @Param('messageId', ParsePositiveBigIntPipe) messageId: string,
    @Body() dto: ForwardMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.forwardChannelMessage(
      user.id,
      channelId,
      messageId,
      dto,
    );
  }

  // ---------------------------------------------------------------------------
  // Message Common Endpoints (Edit & Delete)
  // ---------------------------------------------------------------------------

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
   * Ẩn tin nhắn chỉ riêng ở phía người dùng (Hide for Me).
   */
  @Post('messages/:id/hide')
  async hideMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ id: string; hidden: boolean; scope: 'for_me'; conversationId: string | null; channelId: string | null }> {
    return this.messagesService.hideMessageForUser(user.id, id);
  }

  /**
   * Thu hồi tin nhắn đối với tất cả mọi người trong cuộc trò chuyện (Recall for Everyone).
   */
  @Post('messages/:id/recall')
  async recallMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ id: string; deleted: boolean; scope: 'everyone'; conversationId: string | null; channelId: string | null }> {
    return this.messagesService.recallMessageForEveryone(user.id, id);
  }

  /**
   * Xoá / Thu hồi tin nhắn theo scope (`for_me` hoặc `everyone`).
   */
  @Delete('messages/:id')
  async deleteMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query?: DeleteMessageQueryDto,
  ): Promise<{ id: string; deleted?: boolean; hidden?: boolean; scope: 'for_me' | 'everyone'; conversationId: string | null; channelId: string | null }> {
    const scope = query?.scope ?? DeleteMessageScope.FOR_ME;
    return this.messagesService.deleteMessage(user.id, id, scope);
  }
}
