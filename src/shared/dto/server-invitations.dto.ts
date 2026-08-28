export type InvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'revoked'
  | 'expired';

export type ServerInviteStatus = 'valid' | 'expired' | 'max_used' | 'revoked' | 'invalid';

export interface ServerInviteCandidateDto {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'online' | 'idle' | 'dnd' | 'offline';
}

export interface DirectServerInvitationDto {
  id: string;
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
  inviterId: string;
  inviterDisplayName: string;
  inviterUsername: string;
  inviterAvatarUrl: string | null;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
}

export interface CreateServerInviteLinkDto {
  channelId?: string;
  maxUses?: number;
  expiresInSeconds?: number;
}

export interface ServerInviteLinkResponseDto {
  code: string;
  invitePath: string;
  inviteUrl: string;
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
  channelId?: string | null;
  channelName?: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
}

export interface ServerInvitePreviewDto {
  code: string;
  serverId: string;
  serverName: string;
  serverIconUrl: string | null;
  memberCount: number;
  channelId?: string | null;
  channelName?: string | null;
  inviterDisplayName?: string | null;
  inviterAvatarUrl?: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  status: ServerInviteStatus;
  isExpired: boolean;
  isMaxUsed: boolean;
}

/**
 * Xem trước công khai của một máy chủ theo id: `GET /api/servers/:serverId/preview`.
 *
 * Dùng cho card "giới thiệu máy chủ" khi dán link `origin/channels/:serverId` vào
 * khung chat. Chỉ chứa field công khai an toàn — KHÔNG owner_id, không dữ liệu
 * nhạy cảm — để endpoint có thể để public (người nhận chưa vào server vẫn xem được).
 */
export interface ServerPreviewDto {
  serverId: string;
  name: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
}
