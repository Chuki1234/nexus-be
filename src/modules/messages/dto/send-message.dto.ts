import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString({ message: 'Nội dung tin nhắn phải là chuỗi' })
  @MaxLength(4000, { message: 'Nội dung tin nhắn không được vượt quá 4000 ký tự' })
  content?: string;

  @IsUUID('4', { message: 'clientNonce phải là UUID hợp lệ' })
  @IsOptional()
  clientNonce?: string;

  @IsOptional()
  @IsString({ message: 'replyToId phải là chuỗi ký tự' })
  @Matches(/^[1-9]\d*$/, {
    message: 'replyToId phải là chuỗi số nguyên dương (bigint).',
  })
  replyToId?: string;

  @IsOptional()
  externalMedia?: any;
}

