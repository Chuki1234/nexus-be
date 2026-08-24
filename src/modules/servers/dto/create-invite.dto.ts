import { IsInt, IsOptional, IsPositive, IsUUID, Max, Min } from 'class-validator';

export class CreateInviteLinkDto {
  @IsOptional()
  @IsUUID('4', { message: 'channelId phải là UUID hợp lệ.' })
  channelId?: string;

  @IsOptional()
  @IsInt({ message: 'maxUses phải là số nguyên.' })
  @Min(1, { message: 'maxUses tối thiểu là 1.' })
  @Max(10000, { message: 'maxUses tối đa là 10000.' })
  maxUses?: number;

  @IsOptional()
  @IsInt({ message: 'expiresInSeconds phải là số nguyên.' })
  @IsPositive({ message: 'expiresInSeconds phải là số dương.' })
  @Max(2592000, { message: 'expiresInSeconds tối đa là 30 ngày (2592000 giây).' })
  expiresInSeconds?: number;
}

export class CreateDirectInvitationDto {
  @IsUUID('4', { message: 'inviteeId phải là UUID hợp lệ.' })
  inviteeId: string;
}
