import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateChannelDto {
  @IsOptional()
  @IsString({ message: 'Tên kênh phải là chuỗi ký tự.' })
  @Length(2, 100, { message: 'Tên kênh phải từ 2 đến 100 ký tự.' })
  @Matches(/^[a-z0-9-_]+$/, {
    message: 'Tên kênh chỉ được chứa chữ thường không dấu, số, dấu gạch nối và gạch dưới.',
  })
  name?: string;

  @IsOptional()
  @IsString({ message: 'Chủ đề kênh phải là chuỗi ký tự.' })
  @Length(0, 1024, { message: 'Chủ đề kênh tối đa 1024 ký tự.' })
  topic?: string;
}
