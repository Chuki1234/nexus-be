import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  @Length(2, 100, { message: 'Tên máy chủ phải từ 2 đến 100 ký tự' })
  name?: string;

  @IsOptional()
  @IsString()
  iconUrl?: string | null;

  /** Kênh chữ chính nhận tin nhắn tham gia/rời máy chủ. */
  @IsOptional()
  @IsUUID('4', { message: 'Kênh hệ thống không hợp lệ' })
  systemChannelId?: string;
}
