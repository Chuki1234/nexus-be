import { IsNotEmpty, IsString } from 'class-validator';

export class EditMessageDto {
  @IsString({ message: 'Nội dung tin nhắn phải là chuỗi' })
  @IsNotEmpty({ message: 'Nội dung tin nhắn không được để trống' })
  content: string;
}
