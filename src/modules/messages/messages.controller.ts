import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ParsePositiveBigIntPipe } from '../../common/pipes/parse-positive-bigint.pipe';
import { EditMessageDto } from './dto/edit-message.dto';
import {
  DeleteMessageQueryDto,
  DeleteMessageScope,
} from './dto/delete-message.dto';
import { ForwardMessageDto } from './dto/forward-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import type {
  ChannelMessagesResponseDto,
  ChannelSearchResponseDto,
  MessageResponseDto,
  MessagesPaginationResponseDto,
} from './dto/message-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SetReactionDto } from './dto/set-reaction.dto';
import {
  MessagesService,
  type SetReactionResponseDto,
} from './messages.service';

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

  /** Danh sách tin nhắn đã ghim trong cuộc trò chuyện riêng. */
  @Get('conversations/:id/pins')
  async getConversationPins(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MessageResponseDto[]> {
    return this.messagesService.getConversationPinnedMessages(id, user.id);
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
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
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
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
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
    return this.messagesService.getChannelMessages(user.id, channelId, query);
  }

  /**
   * Tìm kiếm tin nhắn (nội dung + tên file) trong phạm vi một kênh.
   */
  @Get('channels/:channelId/messages/search')
  async searchChannelMessages(
    @CurrentUser() user: User,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<ChannelSearchResponseDto> {
    return this.messagesService.searchChannelMessages(
      channelId,
      user.id,
      q ?? '',
      limit ? Number(limit) : 30,
      before,
    );
  }

  /**
   * Danh sách tin nhắn đã ghim của một kênh.
   */
  @Get('channels/:channelId/pins')
  async getChannelPins(
    @CurrentUser() user: User,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ): Promise<MessageResponseDto[]> {
    return this.messagesService.getChannelPinnedMessages(channelId, user.id);
  }

  /**
   * Ghim một tin nhắn trong DM hoặc kênh máy chủ.
   */
  @Post('messages/:id/pin')
  async pinMessage(
    @CurrentUser() user: User,
    @Param('id', ParsePositiveBigIntPipe) id: string,
  ): Promise<MessageResponseDto> {
    return this.messagesService.setMessagePin(id, user.id, true);
  }

  /**
   * Bỏ ghim một tin nhắn trong DM hoặc kênh máy chủ.
   */
  @Delete('messages/:id/pin')
  async unpinMessage(
    @CurrentUser() user: User,
    @Param('id', ParsePositiveBigIntPipe) id: string,
  ): Promise<MessageResponseDto> {
    return this.messagesService.setMessagePin(id, user.id, false);
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
  ): Promise<{
    success: boolean;
    updated?: boolean;
    lastReadMessageId?: string;
  }> {
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
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async editMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: EditMessageDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<MessageResponseDto> {
    return this.messagesService.editMessage(user.id, id, dto, files);
  }

  /**
   * Ẩn tin nhắn chỉ riêng ở phía người dùng (Hide for Me).
   */
  @Post('messages/:id/hide')
  async hideMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{
    id: string;
    hidden: boolean;
    scope: 'for_me';
    conversationId: string | null;
    channelId: string | null;
  }> {
    return this.messagesService.hideMessageForUser(user.id, id);
  }

  /**
   * Thu hồi tin nhắn đối với tất cả mọi người trong cuộc trò chuyện (Recall for Everyone).
   */
  @Post('messages/:id/recall')
  async recallMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{
    id: string;
    deleted: boolean;
    scope: 'everyone';
    conversationId: string | null;
    channelId: string | null;
  }> {
    return this.messagesService.recallMessageForEveryone(user.id, id);
  }

  /**
   * Proxy tải file/ảnh từ CDN bên ngoài (Discord, Google Drive, v.v.)
   * để vượt qua rào cản CORS trên trình duyệt khi người dùng dán clipboard rich text/media.
   */
  @Post('messages/proxy-attachment')
  async proxyAttachment(
    @CurrentUser() user: User,
    @Body() body: { url: string; filename?: string },
    @Res() res: Response,
  ): Promise<void> {
    const { url, filename } = body;
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new BadRequestException('URL không hợp lệ');
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        throw new BadRequestException(
          `Không thể tải tệp từ nguồn ngoài: HTTP ${response.status}`,
        );
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > 10 * 1024 * 1024) {
        throw new BadRequestException('Tệp vượt quá giới hạn 10MB');
      }

      const contentType =
        response.headers.get('content-type') || 'application/octet-stream';
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > 10 * 1024 * 1024) {
        throw new BadRequestException('Tệp vượt quá giới hạn 10MB');
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length);
      if (filename) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(filename)}"`,
        );
      }
      res.status(200).send(buffer);
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Lỗi khi tải tệp từ URL: ${err?.message || 'Không thể kết nối'}`,
      );
    }
  }

  /**
   * Xoá / Thu hồi tin nhắn theo scope (`for_me` hoặc `everyone`).
   */
  @Delete('messages/:id')
  async deleteMessage(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query?: DeleteMessageQueryDto,
  ): Promise<{
    id: string;
    deleted?: boolean;
    hidden?: boolean;
    scope: 'for_me' | 'everyone';
    conversationId: string | null;
    channelId: string | null;
  }> {
    const scope = query?.scope ?? DeleteMessageScope.FOR_ME;
    return this.messagesService.deleteMessage(user.id, id, scope);
  }
}
