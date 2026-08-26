import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class ForwardMessageDto {
  @IsOptional()
  @IsUUID('4', { message: 'targetConversationId phải là UUID v4 hợp lệ.' })
  targetConversationId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'targetChannelId phải là UUID v4 hợp lệ.' })
  targetChannelId?: string;

  @IsNotEmpty({ message: 'clientNonce không được để trống.' })
  @IsUUID('4', { message: 'clientNonce phải là UUID v4 hợp lệ.' })
  clientNonce!: string;
}
