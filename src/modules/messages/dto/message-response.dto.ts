import type { GiphyMediaDto } from '../../../shared/dto/messages.dto';

export interface MessageAuthorDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AttachmentResponseDto {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  signedUrl: string | null;
  isAvailable?: boolean;
}

export interface ReactionSummaryDto {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface MessageResponseDto {
  id: string;
  channelId: string | null;
  conversationId: string | null;
  authorId: string | null;
  author?: MessageAuthorDto;
  type: 'default' | 'system_join' | 'system_leave';
  content: string | null;
  replyToId: string | null;
  clientNonce: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  isForwarded: boolean;
  externalMedia: GiphyMediaDto | null;
  attachments?: AttachmentResponseDto[];
  reactions?: ReactionSummaryDto[];
  createdAt: string;
}

export interface MessagesPaginationResponseDto {
  messages: MessageResponseDto[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ChannelMessagesResponseDto {
  messages: MessageResponseDto[];
  hasMore: boolean;
  nextCursor?: string;
  lastReadMessageId: string | null;
}
