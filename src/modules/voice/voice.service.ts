import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';
import { RequestVoiceTokenDto, VoiceTokenResponseDto } from './dto/voice-token.dto';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Cấp token LiveKit cho người dùng kết nối vào Voice Channel.
   * Format tên phòng: nexus:{serverId}:voice:{channelId}
   */
  async generateToken(
    userId: string,
    userEmail: string | undefined,
    dto: RequestVoiceTokenDto,
  ): Promise<VoiceTokenResponseDto> {
    const livekitUrl = this.config.get<string>('LIVEKIT_URL') || process.env['LIVEKIT_URL'];
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY') || process.env['LIVEKIT_API_KEY'];
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET') || process.env['LIVEKIT_API_SECRET'];

    if (!livekitUrl || !apiKey || !apiSecret) {
      this.logger.warn(
        'LiveKit Cloud chưa được cấu hình (thiếu LIVEKIT_URL, LIVEKIT_API_KEY hoặc LIVEKIT_API_SECRET trong .env).',
      );
      throw new ServiceUnavailableException(
        'Dịch vụ Voice Room chưa được cấu hình LiveKit credentials. Vui lòng bổ sung LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET vào file .env.',
      );
    }

    const roomName = `nexus:${dto.serverId}:voice:${dto.channelId}`;
    const participantName = dto.displayName || userEmail?.split('@')[0] || `User_${userId.slice(0, 5)}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: participantName,
      ttl: '15m',
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const participantToken = await at.toJwt();

    return {
      serverUrl: livekitUrl,
      participantToken,
      roomName,
      participantIdentity: userId,
      participantName,
    };
  }
}
