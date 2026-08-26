export type DirectCallMode = 'audio' | 'video';

export type DirectCallStatus =
  | 'ringing'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'missed'
  | 'ended'
  | 'failed';

export type DirectCallEndReason =
  | 'hangup'
  | 'no_answer'
  | 'declined'
  | 'caller_cancelled'
  | 'busy'
  | 'permission_denied'
  | 'media_failed'
  | 'network_timeout'
  | 'blocked_or_unfriended'
  | 'failed';

export interface DirectCallParticipantProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface DirectCallDto {
  id: string;
  conversationId: string;
  caller: DirectCallParticipantProfile;
  callee: DirectCallParticipantProfile;
  initialMode: DirectCallMode;
  status: DirectCallStatus;
  livekitRoomName: string;
  initiatedAt: string;
  expiresAt: string;
  answeredAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
  endReason: DirectCallEndReason | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDirectCallRequestDto {
  conversationId: string;
  initialMode: DirectCallMode;
  clientSessionId: string;
}

export interface AnswerDirectCallRequestDto {
  clientSessionId: string;
}

export interface AnswerDirectCallResponseDto {
  call: DirectCallDto;
  shouldJoinMedia: boolean;
}

export interface EndDirectCallRequestDto {
  reason?: string;
}

export interface GetActiveDirectCallResponseDto {
  call: DirectCallDto | null;
  role?: 'caller' | 'callee';
  isMediaOwner?: boolean;
}

export interface DirectCallTokenRequestDto {
  clientSessionId: string;
}

export interface DirectCallTokenResponseDto {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  participantIdentity: string;
  participantName: string;
}
