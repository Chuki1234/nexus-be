import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import type {
  AnswerDirectCallRequestDto,
  AnswerDirectCallResponseDto,
  CreateDirectCallRequestDto,
  DirectCallDto,
  DirectCallTokenRequestDto,
  DirectCallTokenResponseDto,
  EndDirectCallRequestDto,
  GetActiveDirectCallResponseDto,
} from '../../shared/dto/direct-calls.dto';
import { DirectCallsService } from './direct-calls.service';

@Controller('direct-calls')
export class DirectCallsController {
  constructor(private readonly directCallsService: DirectCallsService) {}

  /**
   * POST /api/direct-calls
   * Khởi tạo cuộc gọi thoại hoặc video 1-1 với bạn bè
   */
  @Post()
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async startCall(
    @CurrentUser() user: User,
    @Body() dto: CreateDirectCallRequestDto,
  ): Promise<DirectCallDto> {
    return this.directCallsService.startCall(user.id, dto);
  }

  /**
   * GET /api/direct-calls/active
   * Lấy phiên cuộc gọi đang active của user (phục vụ F5 / Reconnect)
   */
  @Get('active')
  @UseGuards(SupabaseAuthGuard)
  async getActiveCall(
    @CurrentUser() user: User,
    @Query('clientSessionId') clientSessionId?: string,
  ): Promise<GetActiveDirectCallResponseDto> {
    return this.directCallsService.getActiveCall(user.id, clientSessionId);
  }

  /**
   * GET /api/direct-calls/history
   * Lấy lịch sử cuộc gọi trong cuộc trò chuyện DM
   */
  @Get('history')
  @UseGuards(SupabaseAuthGuard)
  async getCallHistory(
    @CurrentUser() user: User,
    @Query('conversationId') conversationId: string,
  ): Promise<DirectCallDto[]> {
    return this.directCallsService.getCallHistory(user.id, conversationId);
  }

  /**
   * POST /api/direct-calls/:id/answer
   * Chấp nhận cuộc gọi đang đổ chuông
   */
  @Post(':id/answer')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async answerCall(
    @CurrentUser() user: User,
    @Param('id') callId: string,
    @Body() dto: AnswerDirectCallRequestDto,
  ): Promise<AnswerDirectCallResponseDto> {
    return this.directCallsService.answerCall(user.id, callId, dto);
  }

  /**
   * POST /api/direct-calls/:id/decline
   * Từ chối cuộc gọi đang đổ chuông (Callee)
   */
  @Post(':id/decline')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async declineCall(
    @CurrentUser() user: User,
    @Param('id') callId: string,
  ): Promise<DirectCallDto> {
    return this.directCallsService.declineCall(user.id, callId);
  }

  /**
   * POST /api/direct-calls/:id/cancel
   * Hủy cuộc gọi đang đổ chuông (Caller)
   */
  @Post(':id/cancel')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async cancelCall(
    @CurrentUser() user: User,
    @Param('id') callId: string,
  ): Promise<DirectCallDto> {
    return this.directCallsService.cancelCall(user.id, callId);
  }

  /**
   * POST /api/direct-calls/:id/end
   * Kết thúc cuộc gọi đang accepted
   */
  @Post(':id/end')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async endCall(
    @CurrentUser() user: User,
    @Param('id') callId: string,
    @Body() dto: EndDirectCallRequestDto,
  ): Promise<DirectCallDto> {
    return this.directCallsService.endCall(user.id, callId, dto);
  }

  /**
   * POST /api/direct-calls/:id/token
   * Lấy LiveKit token kết nối (chỉ cấp cho winning media owner session)
   */
  @Post(':id/token')
  @UseGuards(SupabaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getToken(
    @CurrentUser() user: User,
    @Param('id') callId: string,
    @Body() dto: DirectCallTokenRequestDto,
  ): Promise<DirectCallTokenResponseDto> {
    return this.directCallsService.getToken(user.id, callId, dto);
  }

  /**
   * POST /api/direct-calls/webhook
   * Endpoint nhận webhook từ LiveKit Cloud (xác thực chữ ký)
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: Request,
    @Headers('authorization') authHeader?: string,
  ): Promise<void> {
    const rawBody = (req as any).rawBody || req.body;
    await this.directCallsService.handleWebhook(rawBody, authHeader);
  }
}
