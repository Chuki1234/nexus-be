import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SetReactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  emoji: string;

  @IsBoolean()
  reacted: boolean;

  @IsUUID('4')
  @IsOptional()
  clientMutationId?: string;
}
