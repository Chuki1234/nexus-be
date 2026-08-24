import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from '../conversations/conversations.service';
import { FriendsService } from '../friends/friends.service';
import { PresenceService } from './presence.service';

describe('PresenceService', () => {
  let service: PresenceService;
  let mockSupabase: any;
  let mockFriendsService: any;
  let mockConversationsService: any;

  beforeEach(async () => {
    mockSupabase = {
      client: {
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: { manual_presence: 'online' },
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        }),
      },
    };

    mockFriendsService = {
      getAcceptedFriendUserIds: jest.fn().mockResolvedValue(['user-bob', 'user-charlie']),
    };

    mockConversationsService = {
      getDmPeerUserIds: jest.fn().mockResolvedValue(['user-bob', 'user-david']),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: FriendsService, useValue: mockFriendsService },
        { provide: ConversationsService, useValue: mockConversationsService },
      ],
    }).compile();

    service = module.get<PresenceService>(PresenceService);
  });

  afterEach(() => {
    service?.onModuleDestroy();
    jest.useRealTimers();
  });

  it('kết nối socket đầu tiên -> isFirstConnection: true, status: online, tìm đúng peers', async () => {
    const res = await service.handleUserConnect('user-alice', 'socket-1');

    expect(res.isFirstConnection).toBe(true);
    expect(res.status).toBe('online');
    // Peers kết hợp từ friends (bob, charlie) và dm peers (bob, david) loại trừ trùng lặp
    expect(res.peers.sort()).toEqual(['user-bob', 'user-charlie', 'user-david'].sort());
    expect(service.isUserConnected('user-alice')).toBe(true);
    expect(service.getEffectiveStatus('user-alice')).toBe('online');
  });

  it('mở 2 tab cùng user -> tab 2 isFirstConnection: false; đóng 1 tab vẫn giữ online', async () => {
    const res1 = await service.handleUserConnect('user-alice', 'socket-1');
    expect(res1.isFirstConnection).toBe(true);

    const res2 = await service.handleUserConnect('user-alice', 'socket-2');
    expect(res2.isFirstConnection).toBe(false);

    // Đóng tab 1
    const disc1 = service.handleUserDisconnect('socket-1');
    expect(disc1.isLastDisconnect).toBe(false);
    expect(service.isUserConnected('user-alice')).toBe(true);
    expect(service.getEffectiveStatus('user-alice')).toBe('online');
  });

  it('đóng tab cuối cùng -> kích hoạt grace period 15s; reconnect sau 5s hủy timer và giữ online', async () => {
    jest.useFakeTimers();

    await service.handleUserConnect('user-alice', 'socket-1');

    const disc = service.handleUserDisconnect('socket-1');
    expect(disc.isLastDisconnect).toBe(true);

    // Tua nhanh 5s (vẫn trong 15s grace period)
    await jest.advanceTimersByTimeAsync(5000);
    expect(service.getEffectiveStatus('user-alice')).toBe('offline'); // socket set rỗng nhưng chưa phát tán event

    // Alice mở tab mới trong lúc grace period đang chạy
    const reconnect = await service.handleUserConnect('user-alice', 'socket-new');
    expect(reconnect.isFirstConnection).toBe(true);

    // Tua tiếp 15s -> timer cũ đã bị hủy nên không gây offline
    await jest.advanceTimersByTimeAsync(15000);
    expect(service.getEffectiveStatus('user-alice')).toBe('online');
  });

  it('hết grace period 15s không reconnect -> gọi callback offline với lastSeenAt và danh sách peers', async () => {
    jest.useFakeTimers();

    await service.handleUserConnect('user-alice', 'socket-1');

    const onOffline = jest.fn();
    service.handleUserDisconnect('socket-1', onOffline);

    expect(onOffline).not.toHaveBeenCalled();

    // Tua hết 15s với advanceTimersByTimeAsync để resolve toàn bộ async microtasks trong timer
    await jest.advanceTimersByTimeAsync(15000);

    expect(onOffline).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-alice',
        status: 'offline',
        lastSeenAt: expect.any(String),
        peers: expect.arrayContaining(['user-bob', 'user-charlie', 'user-david']),
      }),
    );
    expect(service.getEffectiveStatus('user-alice')).toBe('offline');
  });

  it('chủ động đăng xuất (explicit logout) -> chuyển offline ngay lập tức không qua grace period', async () => {
    await service.handleUserConnect('user-alice', 'socket-1');

    const res = await service.handleExplicitLogout('user-alice');
    expect(res).not.toBeNull();
    expect(res?.status).toBe('offline');
    expect(res?.lastSeenAt).toBeDefined();
    expect(service.isUserConnected('user-alice')).toBe(false);
    expect(service.getEffectiveStatus('user-alice')).toBe('offline');
  });

  it('tôn trọng manual_presence: dnd hoặc idle khi user đang kết nối', async () => {
    service.setManualPresence('user-alice', 'dnd');
    await service.handleUserConnect('user-alice', 'socket-1');

    expect(service.getEffectiveStatus('user-alice')).toBe('dnd');

    service.setManualPresence('user-alice', 'idle');
    expect(service.getEffectiveStatus('user-alice')).toBe('idle');
  });

  it('getPeersSnapshot trả về snapshot trạng thái chính xác cho tất cả peers', async () => {
    // Bob online, David dnd, Charlie offline
    await service.handleUserConnect('user-bob', 'socket-bob');
    service.setManualPresence('user-david', 'dnd');
    await service.handleUserConnect('user-david', 'socket-david');

    const snapshot = await service.getPeersSnapshot('user-alice');

    expect(snapshot['user-bob']).toEqual({
      status: 'online',
      lastSeenAt: null,
    });
    expect(snapshot['user-david']).toEqual({
      status: 'dnd',
      lastSeenAt: null,
    });
    expect(snapshot['user-charlie']).toEqual({
      status: 'offline',
      lastSeenAt: null,
    });
  });

  it('onModuleDestroy dọn dẹp an toàn toàn bộ timers và socket mappings', async () => {
    jest.useFakeTimers();
    await service.handleUserConnect('user-alice', 'socket-1');
    service.handleUserDisconnect('socket-1');

    service.onModuleDestroy();

    // Không còn timers nào sót lại
    expect(service.isUserConnected('user-alice')).toBe(false);
  });
});
