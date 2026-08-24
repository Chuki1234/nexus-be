export interface ServerMemberDto {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  nickname: string | null;
  role: string;
  joinedAt: string;
}
