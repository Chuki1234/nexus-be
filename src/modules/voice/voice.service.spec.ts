import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { VoiceService } from './voice.service';

describe('VoiceService', () => {
  let service: VoiceService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'LIVEKIT_URL') return 'wss://livekit.example.com';
              if (key === 'LIVEKIT_API_KEY') return 'test-key';
              if (key === 'LIVEKIT_API_SECRET') return 'test-secret-at-least-32-chars-long-here';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('phải được khởi tạo thành công', () => {
    expect(service).toBeDefined();
  });

  it('sinh LiveKit token JWT hợp lệ khi có đủ credentials', async () => {
    const res = await service.generateToken('user-123', 'tai@nexus.app', {
      serverId: 'srv-1',
      channelId: 'chn-voice-1',
      displayName: 'MinhTai',
    });

    expect(res.serverUrl).toBe('wss://livekit.example.com');
    expect(res.roomName).toBe('nexus:srv-1:voice:chn-voice-1');
    expect(res.participantIdentity).toBe('user-123');
    expect(res.participantName).toBe('MinhTai');
    expect(res.participantToken).toBeDefined();
    expect(typeof res.participantToken).toBe('string');
  });

  it('quăng ServiceUnavailableException khi thiếu credentials LiveKit', async () => {
    jest.spyOn(configService, 'get').mockReturnValue(null);
    delete process.env['LIVEKIT_URL'];
    delete process.env['LIVEKIT_API_KEY'];
    delete process.env['LIVEKIT_API_SECRET'];

    await expect(
      service.generateToken('user-123', 'tai@nexus.app', {
        serverId: 'srv-1',
        channelId: 'chn-voice-1',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
