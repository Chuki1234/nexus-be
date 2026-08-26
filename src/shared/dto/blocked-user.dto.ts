export interface BlockedUserDto {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  blockedAt: string;
}
