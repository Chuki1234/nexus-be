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
  /**
   * Trạng thái duyệt của CHÍNH user gọi API trong DM này.
   * - 'pending'  = đây là "message request" từ người lạ, user chỉ đọc tới khi duyệt.
   * - 'accepted' = nhắn tin bình thường.
   */
  requestState?: 'pending' | 'accepted';
  /** Người đối thoại (DM) đã là bạn bè accepted của user gọi API hay chưa. */
  isFriend?: boolean;
}
