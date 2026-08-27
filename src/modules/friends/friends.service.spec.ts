import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { FriendsService } from './friends.service';

interface QueryResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
}

class QueryDouble implements PromiseLike<QueryResponse> {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(readonly table: string, private readonly response: QueryResponse) {}

  select(...args: unknown[]) {
    return this.record('select', args);
  }

  eq(...args: unknown[]) {
    return this.record('eq', args);
  }

  or(...args: unknown[]) {
    return this.record('or', args);
  }

  order(...args: unknown[]) {
    return this.record('order', args);
  }

  in(...args: unknown[]) {
    return this.record('in', args);
  }

  limit(...args: unknown[]) {
    return this.record('limit', args);
  }

  insert(...args: unknown[]) {
    return this.record('insert', args);
  }

  update(...args: unknown[]) {
    return this.record('update', args);
  }

  delete(...args: unknown[]) {
    return this.record('delete', args);
  }

  single(): Promise<QueryResponse> {
    this.calls.push({ method: 'single', args: [] });
    return Promise.resolve(this.response);
  }

  maybeSingle(): Promise<QueryResponse> {
    this.calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve(this.response);
  }

  then<TResult1 = QueryResponse, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }

  private record(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }
}

import { DirectCallsService } from '../direct-calls/direct-calls.service';
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';

describe('FriendsService', () => {
  let service: FriendsService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let eventEmitter: { emit: jest.Mock };
  let directCallsService: { emitTerminatedCall: jest.Mock };
  let queries: QueryDouble[];
  let responses: Array<{ table: string; response: QueryResponse }>;

  const userA = '00000000-0000-4000-8000-000000000001';
  const userB = '00000000-0000-4000-8000-000000000002';
  const userC = '00000000-0000-4000-8000-000000000003';
  const now = '2026-08-22T00:00:00.000Z';

  const profile = (id: string, username: string) => ({
    id,
    username,
    display_name: username === 'ban_a' ? 'Bạn A' : null,
    avatar_url: null,
    status_message: null,
    manual_presence: 'online',
    email: 'khong-duoc-tra-ra@example.com',
    phone: '+84999999999',
  });

  const relationship = (
    firstId: string,
    secondId: string,
    requestedBy: string,
    status: 'pending' | 'accepted' = 'pending',
  ) => ({
    user_a_id: firstId,
    user_b_id: secondId,
    requested_by: requestedBy,
    status,
    created_at: now,
    updated_at: now,
  });

  beforeEach(async () => {
    queries = [];
    responses = [];
    from = jest.fn((table: string) => {
      const queued = responses.shift();
      if (!queued) {
        throw new Error(`Thiếu response giả cho bảng ${table}`);
      }
      expect(table).toBe(queued.table);
      const query = new QueryDouble(table, queued.response);
      queries.push(query);
      return query;
    });
    rpc = jest.fn();
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FriendsService,
        {
          provide: SupabaseService,
          useValue: { client: { from, rpc } },
        },
        {
          provide: EventEmitter2,
          useValue: eventEmitter,
        },
      ],
    }).compile();

    service = module.get(FriendsService);
  });

  const queue = (
    table: string,
    data: unknown,
    error: QueryResponse['error'] = null,
  ) => {
    responses.push({ table, response: { data, error } });
  };

  it('creates an ordered pending pair and returns only public profile fields', async () => {
    queue('profiles', profile(userA, 'ban_a'));
    queue('friendships', null);
    queue('user_blocks', []);
    queue(
      'friendships',
      relationship(userA, userB, userB),
    );

    const result = await service.sendRequest(userB, '  BAN_A  ');

    const insertQuery = queries[3];
    expect(insertQuery.calls).toContainEqual({
      method: 'insert',
      args: [
        {
          user_a_id: userA,
          user_b_id: userB,
          requested_by: userB,
          status: 'pending',
        },
      ],
    });
    expect(result).toEqual({
      id: userA,
      username: 'ban_a',
      displayName: 'Bạn A',
      avatarUrl: null,
      statusMessage: null,
      presence: 'online',
      requestedAt: now,
    });
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('phone');
  });

  it('rejects an unknown username with 404', async () => {
    queue('profiles', null);

    await expect(service.sendRequest(userA, 'khong_ton_tai')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects self friendship with 400', async () => {
    queue('profiles', profile(userA, 'ban_a'));

    await expect(service.sendRequest(userA, 'ban_a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an existing pending request with 409', async () => {
    queue('profiles', profile(userB, 'ban_b'));
    queue('friendships', relationship(userA, userB, userA));

    await expect(service.sendRequest(userA, 'ban_b')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects sending friend request if blocked in user_blocks', async () => {
    queue('profiles', profile(userB, 'ban_b'));
    queue('friendships', null);
    queue('user_blocks', [{ blocker_id: userB }]);

    await expect(service.sendRequest(userA, 'ban_b')).rejects.toThrow(
      'Không thể gửi lời mời kết bạn do có quan hệ chặn.',
    );
  });

  it('maps a unique race from Supabase to 409', async () => {
    queue('profiles', profile(userB, 'ban_b'));
    queue('friendships', null);
    queue('user_blocks', []);
    queue('friendships', null, {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    });

    await expect(service.sendRequest(userA, 'ban_b')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('loads accepted friends and profiles in two batch queries without sensitive fields', async () => {
    queue(
      'friendships',
      [relationship(userA, userB, userA, 'accepted')],
    );
    queue('profiles', [profile(userB, 'ban_b')]);

    const result = await service.listFriends(userA);

    expect(from).toHaveBeenCalledTimes(2);
    expect(queries[1].calls).toContainEqual({
      method: 'in',
      args: ['id', [userB]],
    });
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('example.com');
    expect(JSON.stringify(result)).not.toContain('+849');
  });

  it('splits pending requests into incoming and outgoing', async () => {
    queue('friendships', [
      relationship(userA, userB, userB),
      relationship(userB, userC, userC),
    ]);
    queue('profiles', [profile(userA, 'ban_a'), profile(userC, 'ban_c')]);

    const result = await service.listRequests(userB);

    expect(result.outgoing.map((item) => item.id)).toEqual([userA]);
    expect(result.incoming.map((item) => item.id)).toEqual([userC]);
  });

  it('accepts only an incoming pending request', async () => {
    queue('friendships', relationship(userA, userB, userA));
    queue(
      'friendships',
      relationship(userA, userB, userA, 'accepted'),
    );
    // acceptRequest nay tra DM giua hai nguoi de bo trang thai "cho duyet";
    // khong co DM -> tra null, bo qua buoc cap nhat conversation_participants.
    queue('conversations', null);
    queue('profiles', [profile(userA, 'ban_a')]);

    const result = await service.acceptRequest(userB, userA);

    expect(queries[1].calls).toContainEqual({
      method: 'update',
      args: [{ status: 'accepted' }],
    });
    expect(result.id).toBe(userA);
    expect(result.friendsSince).toBe(now);
  });

  it('does not let the sender accept their own outgoing request', async () => {
    queue('friendships', relationship(userA, userB, userA));

    await expect(service.acceptRequest(userA, userB)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes a pending request or accepted friendship by exact status and cleans up conversation', async () => {
    queue('friendships', { ...relationship(userA, userB, userA), status: 'accepted' });
    queue('friendships', null);
    queue('conversations', { id: 'conv-123' });
    queue('conversations', null);

    await expect(service.removeFriend(userA, userB)).resolves.toBeUndefined();
    expect(queries[1].calls).toContainEqual({
      method: 'delete',
      args: [],
    });
    expect(queries[1].calls).toContainEqual({
      method: 'eq',
      args: ['status', 'accepted'],
    });
    expect(queries[3].calls).toContainEqual({
      method: 'delete',
      args: [],
    });
  });

  it('returns 404 when the relationship to delete does not exist', async () => {
    queue('friendships', null);

    await expect(service.removeFriend(userA, userB)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps a missing friendships table to 503', async () => {
    queue('friendships', null, {
      code: '42P01',
      message: 'relation public.friendships does not exist',
    });

    await expect(service.listFriends(userA)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('User Blocking & Realtime Invalidation', () => {
    it('lists blocked users via list_blocked_users RPC', async () => {
      rpc.mockResolvedValueOnce({
        data: [
          {
            id: userB,
            username: 'ban_b',
            display_name: 'Bạn B',
            avatar_url: null,
            blocked_at: now,
          },
        ],
        error: null,
      });

      const blockedList = await service.listBlockedUsers(userA);
      expect(rpc).toHaveBeenCalledWith('list_blocked_users', { p_user_id: userA });
      expect(blockedList).toEqual([
        {
          id: userB,
          username: 'ban_b',
          displayName: 'Bạn B',
          avatarUrl: null,
          blockedAt: now,
        },
      ]);
    });

    it('falls back to querying user_blocks directly if list_blocked_users RPC fails', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'structure of query does not match function result type' },
      });

      queue('user_blocks', [{ blocked_user_id: userB, created_at: now }]);
      queue('profiles', [profile(userB, 'ban_b')]);

      const blockedList = await service.listBlockedUsers(userA);
      expect(blockedList).toEqual([
        {
          id: userB,
          username: 'ban_b',
          displayName: null,
          avatarUrl: null,
          blockedAt: now,
        },
      ]);
    });

    it('rejects self-blocking with BadRequestException', async () => {
      await expect(service.blockUser(userA, userA)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('blocks user, emits user:block-created and relationship:invalidated events, and terminates active calls', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          blocked_user: {
            id: userB,
            username: 'ban_b',
            displayName: 'Bạn B',
            avatarUrl: null,
            blockedAt: now,
          },
          terminated_call_ids: ['call-123'],
        },
        error: null,
      });

      const result = await service.blockUser(userA, userB);

      expect(rpc).toHaveBeenCalledWith('block_user', {
        p_blocker_id: userA,
        p_blocked_user_id: userB,
      });
      expect(result).toEqual({
        id: userB,
        username: 'ban_b',
        displayName: 'Bạn B',
        avatarUrl: null,
        blockedAt: now,
      });

      // Emits block created to blocker A
      expect(eventEmitter.emit).toHaveBeenCalledWith(CHAT_EVENTS.USER_BLOCK_CREATED, {
        blockerId: userA,
        blockedUser: result,
      });

      // Emits neutral invalidation to blocked user B
      expect(eventEmitter.emit).toHaveBeenCalledWith(CHAT_EVENTS.RELATIONSHIP_INVALIDATED, {
        targetUserId: userB,
        invalidatedWithUserId: userA,
      });

      // Emits terminated call event
      expect(eventEmitter.emit).toHaveBeenCalledWith(CHAT_EVENTS.DIRECT_CALL_TERMINATED, {
        callId: 'call-123',
      });
    });

    it('unblocks user and emits user:block-removed event', async () => {
      rpc.mockResolvedValueOnce({ error: null });

      await service.unblockUser(userA, userB);

      expect(rpc).toHaveBeenCalledWith('unblock_user', {
        p_blocker_id: userA,
        p_blocked_user_id: userB,
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(CHAT_EVENTS.USER_BLOCK_REMOVED, {
        blockerId: userA,
        blockedUserId: userB,
      });
    });
  });
});

