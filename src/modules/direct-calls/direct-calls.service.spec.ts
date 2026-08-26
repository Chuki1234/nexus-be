import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DirectCallsService } from './direct-calls.service';
import { DirectCallTokenService } from './direct-call-token.service';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ChatGateway } from '../realtime/chat.gateway';

describe('DirectCallsService', () => {
  let service: DirectCallsService;
  let mockSupabase: any;
  let mockChatGateway: any;
  let mockTokenService: any;
  let mockConfig: any;

  beforeEach(async () => {
    mockSupabase = {
      client: {
        rpc: jest.fn(),
        from: jest.fn(),
      },
    };

    mockChatGateway = {
      server: {
        to: jest.fn().mockReturnValue({
          emit: jest.fn(),
        }),
      },
    };

    mockTokenService = {
      generateToken: jest.fn().mockResolvedValue({
        serverUrl: 'https://livekit.test',
        participantToken: 'mock_jwt_token',
        roomName: 'nexus:dm-call:111',
        participantIdentity: 'user-1',
        participantName: 'User One',
      }),
    };

    mockConfig = {
      get: jest.fn().mockReturnValue('mock_secret'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectCallsService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: ChatGateway, useValue: mockChatGateway },
        { provide: DirectCallTokenService, useValue: mockTokenService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<DirectCallsService>(DirectCallsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('startCall', () => {
    it('should create call and emit socket events to both participants', async () => {
      const mockCallData = {
        id: 'call-123',
        conversation_id: 'conv-123',
        caller_id: 'user-1',
        callee_id: 'user-2',
        caller_session_id: 'session-1',
        answered_session_id: null,
        initial_mode: 'video',
        status: 'ringing',
        livekit_room_name: 'nexus:dm-call:call-123',
        initiated_at: '2026-08-25T10:00:00Z',
        expires_at: '2026-08-25T10:00:45Z',
        answered_at: null,
        connected_at: null,
        ended_at: null,
        ended_by: null,
        end_reason: null,
        version: 1,
        created_at: '2026-08-25T10:00:00Z',
        updated_at: '2026-08-25T10:00:00Z',
      };

      mockSupabase.client.rpc.mockResolvedValue({
        data: [mockCallData],
        error: null,
      });

      mockSupabase.client.from.mockReturnValue({
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockResolvedValue({
            data: [
              { id: 'user-1', username: 'caller', display_name: 'Caller', avatar_url: null },
              { id: 'user-2', username: 'callee', display_name: 'Callee', avatar_url: null },
            ],
            error: null,
          }),
        }),
      });

      const result = await service.startCall('user-1', {
        conversationId: 'conv-123',
        initialMode: 'video',
        clientSessionId: 'session-1',
      });

      expect(result.id).toBe('call-123');
      expect(result.status).toBe('ringing');
      expect(mockChatGateway.server.to).toHaveBeenCalledWith('user:user-2');
      expect(mockChatGateway.server.to).toHaveBeenCalledWith('user:user-1');
    });

    it('should throw ConflictException on BUSY signal', async () => {
      mockSupabase.client.rpc.mockResolvedValue({
        data: null,
        error: { message: 'BUSY: Người dùng hiện đang trong một cuộc gọi khác.', code: '23505' },
      });

      await expect(
        service.startCall('user-1', {
          conversationId: 'conv-123',
          initialMode: 'audio',
          clientSessionId: 'session-1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ForbiddenException if friendship or block check fails', async () => {
      mockSupabase.client.rpc.mockResolvedValue({
        data: null,
        error: { message: 'Chỉ có thể gọi điện với người dùng đã kết bạn.' },
      });

      await expect(
        service.startCall('user-1', {
          conversationId: 'conv-123',
          initialMode: 'audio',
          clientSessionId: 'session-1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('answerCall', () => {
    it('should answer call and return shouldJoinMedia true for winning session', async () => {
      const mockCallData = {
        id: 'call-123',
        conversation_id: 'conv-123',
        caller_id: 'user-1',
        callee_id: 'user-2',
        caller_session_id: 'session-1',
        answered_session_id: 'session-b1',
        initial_mode: 'video',
        status: 'accepted',
        livekit_room_name: 'nexus:dm-call:call-123',
        initiated_at: '2026-08-25T10:00:00Z',
        expires_at: '2026-08-25T10:00:45Z',
        answered_at: '2026-08-25T10:00:05Z',
        connected_at: null,
        ended_at: null,
        ended_by: null,
        end_reason: null,
        version: 2,
        created_at: '2026-08-25T10:00:00Z',
        updated_at: '2026-08-25T10:00:05Z',
        should_join_media: true,
      };

      mockSupabase.client.rpc.mockResolvedValue({
        data: [mockCallData],
        error: null,
      });

      mockSupabase.client.from.mockReturnValue({
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockResolvedValue({
            data: [
              { id: 'user-1', username: 'caller', display_name: 'Caller', avatar_url: null },
              { id: 'user-2', username: 'callee', display_name: 'Callee', avatar_url: null },
            ],
            error: null,
          }),
        }),
      });

      const result = await service.answerCall('user-2', 'call-123', {
        clientSessionId: 'session-b1',
      });

      expect(result.shouldJoinMedia).toBe(true);
      expect(result.call.status).toBe('accepted');
    });
  });

  describe('getToken', () => {
    it('should reject token request if clientSessionId does not match media owner', async () => {
      mockSupabase.client.from.mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'call-123',
                caller_id: 'user-1',
                callee_id: 'user-2',
                caller_session_id: 'session-a1',
                answered_session_id: 'session-b1',
                status: 'accepted',
              },
              error: null,
            }),
          }),
        }),
      });

      await expect(
        service.getToken('user-2', 'call-123', { clientSessionId: 'session-b2_loser' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
