export interface ServerMemberDto {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  nickname: string | null;
  role: string;
  roles?: string[];
  joinedAt: string;
  nexusJoinedAt?: string | null;
  joinMethod?: string | null;
}
