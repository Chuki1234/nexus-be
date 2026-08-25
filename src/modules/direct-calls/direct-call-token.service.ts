import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';
import { DirectCallTokenResponseDto } from '../../shared/dto/direct-calls.dto';

@Injectable()
export class DirectCallTokenService {
  private readonly logger = new Logger(DirectCallTokenService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Sinh LiveKit token ngắn hạn (TTL 3m) cho cuộc gọi 1-1 bạn bè.
   * Format tên phòng canonical: nexus:dm-call:{callId}
   */
  async generateToken(
    callId: string,
    userId: string,
    displayName?: string | null,
    username?: string | null,
  ): Promise<DirectCallTokenResponseDto> {
    const livekitUrl =
      this.config.get<string>('LIVEKIT_URL') || process.env['LIVEKIT_URL'];
    const apiKey =
      this.config.get<string>('LIVEKIT_API_KEY') ||
      process.env['LIVEKIT_API_KEY'];
    const apiSecret =
      this.config.get<string>('LIVEKIT_API_SECRET') ||
      process.env['LIVEKIT_API_SECRET'];

    if (!livekitUrl || !apiKey || !apiSecret) {
      this.logger.warn(
        'LiveKit chưa được cấu hình (thiếu LIVEKIT_URL, LIVEKIT_API_KEY hoặc LIVEKIT_API_SECRET).',
      );
      throw new ServiceUnavailableException(
        'Dịch vụ cuộc gọi chưa được cấu hình LiveKit credentials.',
      );
    }

    const roomName = `nexus:dm-call:${callId}`;
    const participantName =
      displayName || username || `User_${userId.slice(0, 5)}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: participantName,
      ttl: '3m', // TTL ngắn hạn 3 phút cho initial join
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
