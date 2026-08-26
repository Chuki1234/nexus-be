import type { PresenceStatus } from '../../../shared/dto/common';

export interface FriendSummaryDto {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  statusMessage: string | null;
  presence: PresenceStatus;
  friendsSince: string;
}

export interface FriendRequestSummaryDto {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  statusMessage: string | null;
  presence: PresenceStatus;
  requestedAt: string;
}

export interface FriendRequestsResponseDto {
  incoming: FriendRequestSummaryDto[];
  outgoing: FriendRequestSummaryDto[];
}
