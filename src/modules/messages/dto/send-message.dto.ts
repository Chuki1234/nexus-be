import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsString({ message: 'Nội dung tin nhắn phải là chuỗi' })
  @IsNotEmpty({ message: 'Nội dung tin nhắn không được để trống' })
  @MaxLength(4000, { message: 'Nội dung tin nhắn không được vượt quá 4000 ký tự' })
  content: string;

  @IsUUID('4', { message: 'clientNonce phải là UUID hợp lệ' })
  @IsOptional()
  clientNonce?: string;

  @IsOptional()
  replyToId?: string;
}
