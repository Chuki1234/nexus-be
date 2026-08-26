import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { ConversationsService } from './conversations.service';
import { CreateDmDto } from './dto/create-dm.dto';
import type { ConversationResponseDto } from './dto/conversation-response.dto';

@Controller('conversations')
@UseGuards(SupabaseAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  /**
   * Tạo hoặc mở cuộc trò chuyện trực tiếp 1-1 với một bạn bè.
   */
  @Post('dm')
  async getOrCreateDm(
    @CurrentUser() user: User,
    @Body() dto: CreateDmDto,
  ): Promise<ConversationResponseDto> {
    return this.conversationsService.getOrCreateDm(user.id, dto.recipientId);
  }

  /**
   * Lấy danh sách tất cả các cuộc trò chuyện của người dùng hiện tại.
   */
  @Get()
  async listConversations(
    @CurrentUser() user: User,
  ): Promise<ConversationResponseDto[]> {
    return this.conversationsService.listConversations(user.id);
  }

  /**
   * Lấy chi tiết 1 cuộc trò chuyện (yêu cầu là thành viên).
   */
  @Get(':id')
  async getConversation(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationResponseDto> {
    return this.conversationsService.getConversationById(user.id, id);
  }
}
