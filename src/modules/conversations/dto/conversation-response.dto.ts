import type { PresenceStatus } from '../../../shared/dto/common';

export interface ConversationParticipantProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  statusMessage: string | null;
  presence: PresenceStatus;
}

export interface ConversationResponseDto {
  id: string;
  type: 'dm' | 'group';
  name: string | null;
  iconUrl: string | null;
  recipient?: ConversationParticipantProfile;
  unreadCount?: number;
  lastMessage?: {
    id: string;
    content: string | null;
    createdAt: string;
  };
  createdAt: string;
}
