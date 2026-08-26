import { ServerTemplateDefinition } from '../constants/server-templates.constant';

export interface ServerSummaryDto {
  id: string;
  name: string;
  templateId?: string;
  iconUrl: string | null;
  unread: boolean;
  mentionCount: number;
}

export interface ChannelSummaryDto {
  id: string;
  name: string;
  type: 'text' | 'voice';
  topic: string | null;
  position?: number;
  unread: boolean;
  mentionCount: number;
}

export interface CreateServerResponseDto {
  server: ServerSummaryDto;
  channels: ChannelSummaryDto[];
}

export interface ServerWithChannelsDto extends ServerSummaryDto {
  channels: ChannelSummaryDto[];
}

export type ServerTemplateDto = ServerTemplateDefinition;
