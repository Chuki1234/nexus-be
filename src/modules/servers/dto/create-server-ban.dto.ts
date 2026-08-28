import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateServerBanDto {
  @IsUUID()
  @IsNotEmpty()
  targetUserId: string;

  @IsString()
  @IsOptional()
  reason?: string;
}
