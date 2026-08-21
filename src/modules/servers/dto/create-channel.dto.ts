import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateChannelDto {
  @IsString({ message: 'Tên kênh phải là chuỗi ký tự.' })
  @IsNotEmpty({ message: 'Tên kênh không được để trống.' })
  @MinLength(1, { message: 'Tên kênh phải có ít nhất 1 ký tự.' })
  @MaxLength(100, { message: 'Tên kênh không được vượt quá 100 ký tự.' })
  name: string;

  @IsString({ message: 'Loại kênh phải là chuỗi ký tự.' })
  @IsIn(['text', 'voice'], { message: 'Loại kênh chỉ có thể là "text" hoặc "voice".' })
  type: 'text' | 'voice';

  @IsOptional()
  @IsString({ message: 'Chủ đề kênh phải là chuỗi ký tự.' })
  @MaxLength(1024, { message: 'Chủ đề kênh không được vượt quá 1024 ký tự.' })
  topic?: string;
}
