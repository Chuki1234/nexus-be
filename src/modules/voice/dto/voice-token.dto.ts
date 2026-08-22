import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RequestVoiceTokenDto {
  @IsString({ message: 'serverId phải là chuỗi ký tự.' })
  @IsNotEmpty({ message: 'serverId không được để trống.' })
  serverId!: string;

  @IsString({ message: 'channelId phải là chuỗi ký tự.' })
  @IsNotEmpty({ message: 'channelId không được để trống.' })
  channelId!: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

export interface VoiceTokenResponseDto {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  participantIdentity: string;
  participantName: string;
}
