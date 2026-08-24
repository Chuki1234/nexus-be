import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import type { User } from '@supabase/supabase-js';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';

describe('FriendsController', () => {
  let controller: FriendsController;
  let friends: jest.Mocked<FriendsService>;

  const user = { id: '00000000-0000-4000-8000-000000000002' } as User;
  const otherUserId = '00000000-0000-4000-8000-000000000001';
  const friend = {
    id: otherUserId,
    username: 'ban_test',
    displayName: 'Bạn Test',
    avatarUrl: null,
    statusMessage: null,
    presence: 'online' as const,
    friendsSince: '2026-08-22T00:00:00.000Z',
  };
  const request = {
    id: otherUserId,
    username: 'ban_test',
    displayName: 'Bạn Test',
    avatarUrl: null,
    statusMessage: null,
    presence: 'online' as const,
    requestedAt: '2026-08-22T00:00:00.000Z',
  };

  beforeEach(async () => {
    const mockFriends = {
      sendRequest: jest.fn(),
      listFriends: jest.fn(),
      listRequests: jest.fn(),
      acceptRequest: jest.fn(),
      deleteRequest: jest.fn(),
      removeFriend: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FriendsController],
      providers: [{ provide: FriendsService, useValue: mockFriends }],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(FriendsController);
    friends = module.get(FriendsService);
  });

  it('protects every route with SupabaseAuthGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      FriendsController,
    ) as unknown[];
    expect(guards).toContain(SupabaseAuthGuard);
  });

  it('sends a request with the authenticated user id', async () => {
    friends.sendRequest.mockResolvedValue(request);

    await expect(
      controller.sendRequest(user, { username: 'ban_test' }),
    ).resolves.toEqual(request);
    expect(friends.sendRequest).toHaveBeenCalledWith(user.id, 'ban_test');
  });

  it('lists accepted friends and pending requests separately', async () => {
    friends.listFriends.mockResolvedValue([friend]);
    friends.listRequests.mockResolvedValue({
      incoming: [request],
      outgoing: [],
    });

    await expect(controller.listFriends(user)).resolves.toEqual([friend]);
    await expect(controller.listRequests(user)).resolves.toEqual({
      incoming: [request],
      outgoing: [],
    });
  });

  it('accepts, rejects or cancels, and removes through the service', async () => {
    friends.acceptRequest.mockResolvedValue(friend);
    friends.deleteRequest.mockResolvedValue();
    friends.removeFriend.mockResolvedValue();

    await expect(
      controller.acceptRequest(user, otherUserId),
    ).resolves.toEqual(friend);
    await expect(
      controller.deleteRequest(user, otherUserId),
    ).resolves.toBeUndefined();
    await expect(
      controller.removeFriend(user, otherUserId),
    ).resolves.toBeUndefined();

    expect(friends.acceptRequest).toHaveBeenCalledWith(user.id, otherUserId);
    expect(friends.deleteRequest).toHaveBeenCalledWith(user.id, otherUserId);
    expect(friends.removeFriend).toHaveBeenCalledWith(user.id, otherUserId);
  });
});
