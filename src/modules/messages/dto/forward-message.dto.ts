import { IsNotEmpty, IsUUID } from 'class-validator';

export class ForwardMessageDto {
  @IsNotEmpty({ message: 'targetConversationId không được để trống.' })
  @IsUUID('4', { message: 'targetConversationId phải là UUID v4 hợp lệ.' })
  targetConversationId!: string;

  @IsNotEmpty({ message: 'clientNonce không được để trống.' })
  @IsUUID('4', { message: 'clientNonce phải là UUID v4 hợp lệ.' })
  clientNonce!: string;
}
