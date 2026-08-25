import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DirectCallCleanupWorker } from './direct-call-cleanup.worker';
import { SupabaseService } from '../../infra/supabase/supabase.service';

describe('DirectCallCleanupWorker', () => {
  let worker: DirectCallCleanupWorker;
  let mockSupabase: any;
  let mockConfig: any;
  let mockRoomService: any;

  const sampleJob = {
    id: 'outbox-job-1',
    call_id: 'call-1',
    room_name: 'nexus:dm-call:call-1',
    status: 'pending',
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
  };

  beforeEach(async () => {
    mockRoomService = {
      deleteRoom: jest.fn().mockResolvedValue(undefined),
    };

    mockSupabase = {
      client: {
        from: jest.fn(),
      },
    };

    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'LIVEKIT_URL') return 'wss://livekit.test';
        if (key === 'LIVEKIT_API_KEY') return 'test_key';
        if (key === 'LIVEKIT_API_SECRET') return 'test_secret';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectCallCleanupWorker,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    worker = module.get<DirectCallCleanupWorker>(DirectCallCleanupWorker);
    (worker as any).roomService = mockRoomService;
  });

  afterEach(() => {
    worker.stopWorker();
  });

  it('1. should be defined', () => {
    expect(worker).toBeDefined();
  });

  it('2. should return 0 if no jobs found in outbox', async () => {
    mockSupabase.client.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnValue({
          lte: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const count = await worker.processOutbox();
    expect(count).toBe(0);
  });

  it('3. should successfully deleteRoom and mark status completed', async () => {
    const mockUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    });

    mockSupabase.client.from.mockImplementation((table: string) => {
      if (table === 'direct_call_room_cleanup_outbox') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              lte: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: [sampleJob],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: mockUpdate,
        };
      }
      return {};
    });

    const count = await worker.processOutbox();

    expect(count).toBe(1);
    expect(mockRoomService.deleteRoom).toHaveBeenCalledWith('nexus:dm-call:call-1');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        attempts: 1,
      }),
    );
  });

  it('4. should treat 404 / room not found as successful completion', async () => {
    mockRoomService.deleteRoom.mockRejectedValueOnce(new Error('could not find room: 404'));

    const mockUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    });

    mockSupabase.client.from.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnValue({
          lte: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({
                data: [sampleJob],
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: mockUpdate,
    }));

    const count = await worker.processOutbox();

    expect(count).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        attempts: 1,
      }),
    );
  });

  it('5. should retry with exponential backoff on LiveKit 5xx / connection timeout', async () => {
    mockRoomService.deleteRoom.mockRejectedValueOnce(new Error('LiveKit 503 Service Unavailable'));

    const mockUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    });

    mockSupabase.client.from.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnValue({
          lte: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({
                data: [sampleJob],
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: mockUpdate,
    }));

    const count = await worker.processOutbox();

    expect(count).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        attempts: 1,
        last_error: 'LiveKit 503 Service Unavailable',
      }),
    );
  });

  it('6. should mark job failed when max_attempts is reached', async () => {
    const exhaustedJob = { ...sampleJob, attempts: 4, max_attempts: 5 };
    mockRoomService.deleteRoom.mockRejectedValueOnce(new Error('Persistent LiveKit Error'));

    const mockUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    });

    mockSupabase.client.from.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnValue({
          lte: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({
                data: [exhaustedJob],
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: mockUpdate,
    }));

    const count = await worker.processOutbox();

    expect(count).toBe(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        attempts: 5,
        last_error: 'Persistent LiveKit Error',
      }),
    );
  });
});
