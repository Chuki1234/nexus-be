import { BlockedUserDto } from '../../../shared';

export class BlockedUserResponseDto implements BlockedUserDto {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  blockedAt: string;
}
