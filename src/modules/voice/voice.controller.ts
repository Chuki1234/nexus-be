import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RequestVoiceTokenDto, VoiceTokenResponseDto } from './dto/voice-token.dto';
import { VoiceService } from './voice.service';

@Controller('voice')
@UseGuards(SupabaseAuthGuard)
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  /**
   * POST /api/voice/channels/:channelId/token
   *
   * Cấp LiveKit JWT token để client kết nối vào voice room.
   */
  @Post('channels/:channelId/token')
  @HttpCode(HttpStatus.OK)
  async getChannelVoiceToken(
    @CurrentUser() user: User,
    @Param('channelId') channelId: string,
    @Body() body: Partial<RequestVoiceTokenDto>,
  ): Promise<VoiceTokenResponseDto> {
    const dto: RequestVoiceTokenDto = {
      serverId: body.serverId || 'default',
      channelId,
      displayName: body.displayName,
    };
    return this.voiceService.generateToken(user.id, user.email, dto);
  }

  /**
   * POST /api/voice/token
   *
   * Endpoint tổng quát cấp LiveKit token theo serverId và channelId.
   */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  async getVoiceToken(
    @CurrentUser() user: User,
    @Body() dto: RequestVoiceTokenDto,
  ): Promise<VoiceTokenResponseDto> {
    return this.voiceService.generateToken(user.id, user.email, dto);
  }
}
