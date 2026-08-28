import { IsOptional, IsString } from 'class-validator';

export class EditMessageDto {
  @IsString({ message: 'Nội dung tin nhắn phải là chuỗi' })
  @IsOptional()
  content?: string;
}
