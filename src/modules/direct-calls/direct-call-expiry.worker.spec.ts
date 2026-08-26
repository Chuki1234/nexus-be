import { Test, TestingModule } from '@nestjs/testing';
import { DirectCallExpiryWorker } from './direct-call-expiry.worker';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ChatGateway } from '../realtime/chat.gateway';

describe('DirectCallExpiryWorker', () => {
  let worker: DirectCallExpiryWorker;
  let mockSupabase: any;
  let mockChatGateway: any;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectCallExpiryWorker,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: ChatGateway, useValue: mockChatGateway },
      ],
    }).compile();

    worker = module.get<DirectCallExpiryWorker>(DirectCallExpiryWorker);
  });

  afterEach(() => {
    worker.stopWorker();
  });

  it('should be defined', () => {
    expect(worker).toBeDefined();
  });

  it('should process expired calls and emit missed events exactly for returning rows', async () => {
    const mockExpiredCalls = [
      {
        id: 'call-exp-1',
        conversation_id: 'conv-1',
        caller_id: 'user-1',
        callee_id: 'user-2',
        initial_mode: 'audio',
        status: 'missed',
        livekit_room_name: 'nexus:dm-call:call-exp-1',
        initiated_at: '2026-08-25T10:00:00Z',
        expires_at: '2026-08-25T10:00:45Z',
        answered_at: null,
        connected_at: null,
        ended_at: '2026-08-25T10:00:46Z',
        ended_by: null,
        end_reason: 'no_answer',
        version: 2,
        created_at: '2026-08-25T10:00:00Z',
        updated_at: '2026-08-25T10:00:46Z',
      },
    ];

    mockSupabase.client.rpc.mockResolvedValue({
      data: mockExpiredCalls,
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

    const count = await worker.processExpiredCalls();
    expect(count).toBe(1);
    expect(mockChatGateway.server.to).toHaveBeenCalledWith('user:user-1');
    expect(mockChatGateway.server.to).toHaveBeenCalledWith('user:user-2');
  });
});
