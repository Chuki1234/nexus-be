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
   *
   * Format tên phòng: nexus:voice:{channelId}
   *
   * KHÔNG nhét serverId vào tên phòng: channelId đã là UUID duy nhất toàn cục.
   * Trước đây dùng `nexus:{serverId}:voice:{channelId}` — nếu một client gửi
   * serverId lệch/thiếu, nó rơi vào phòng LiveKit khác dù cùng channel, gây ra
   * hiện tượng "màn hình gọi không thấy đủ người" trong khi sidebar (voice-state
   * socket) vẫn hiện đủ. Chỉ khoá theo channelId để mọi người cùng kênh chắc
   * chắn vào chung một phòng.
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

    const roomName = `nexus:voice:${dto.channelId}`;
    const participantName = dto.displayName || userEmail?.split('@')[0] || `User_${userId.slice(0, 5)}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: participantName,
      // FE đọc metadata này để hiện đúng avatar trên tile gọi (thay vì chữ cái).
      metadata: JSON.stringify({ avatarUrl: dto.avatarUrl ?? null }),
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
