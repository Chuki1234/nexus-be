import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

describe('VoiceController', () => {
  let controller: VoiceController;
  let voiceService: {
    generateToken: jest.Mock;
  };

  const mockUser: User = {
    id: 'usr-tai-1',
    app_metadata: {},
    user_metadata: { full_name: 'Minh Tài' },
    aud: 'authenticated',
    created_at: new Date().toISOString(),
    email: 'minhtai@nexus.app',
  };

  beforeEach(async () => {
    voiceService = {
      generateToken: jest.fn().mockResolvedValue({
        serverUrl: 'wss://livekit.example.com',
        participantToken: 'mock.jwt.token',
        roomName: 'nexus:voice:chn-1',
        participantIdentity: 'usr-tai-1',
        participantName: 'Minh Tài',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VoiceController],
      providers: [
        {
          provide: VoiceService,
          useValue: voiceService,
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<VoiceController>(VoiceController);
  });

  it('phải được khởi tạo thành công', () => {
    expect(controller).toBeDefined();
  });

  it('POST /api/voice/channels/:channelId/token gọi generateToken với đúng params', async () => {
    const res = await controller.getChannelVoiceToken(mockUser, 'chn-1', {
      serverId: 'srv-1',
      displayName: 'Minh Tài',
    });

    expect(voiceService.generateToken).toHaveBeenCalledWith('usr-tai-1', 'minhtai@nexus.app', {
      serverId: 'srv-1',
      channelId: 'chn-1',
      displayName: 'Minh Tài',
    });
    expect(res.participantToken).toBe('mock.jwt.token');
  });

  it('POST /api/voice/token gọi generateToken với trọn bộ DTO', async () => {
    const res = await controller.getVoiceToken(mockUser, {
      serverId: 'srv-2',
      channelId: 'chn-2',
      displayName: 'Tài',
    });

    expect(voiceService.generateToken).toHaveBeenCalledWith('usr-tai-1', 'minhtai@nexus.app', {
      serverId: 'srv-2',
      channelId: 'chn-2',
      displayName: 'Tài',
    });
    expect(res.roomName).toBe('nexus:voice:chn-1');
  });
});
