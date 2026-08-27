import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateChannelDto {
  @IsOptional()
  @IsString({ message: 'Tên kênh phải là chuỗi ký tự.' })
  @Length(1, 100, { message: 'Tên kênh phải từ 1 đến 100 ký tự.' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'Chủ đề kênh phải là chuỗi ký tự.' })
  @Length(0, 1024, { message: 'Chủ đề kênh tối đa 1024 ký tự.' })
  topic?: string;

  @IsOptional()
  slowmode?: number;

  @IsOptional()
  isAgeRestricted?: boolean;

  @IsOptional()
  contentVisibility?: string;
}
