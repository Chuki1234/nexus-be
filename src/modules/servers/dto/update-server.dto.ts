import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  @Length(2, 100, { message: 'Tên máy chủ phải từ 2 đến 100 ký tự' })
  name?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;
}
