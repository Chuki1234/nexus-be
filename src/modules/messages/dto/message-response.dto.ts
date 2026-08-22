export interface MessageAuthorDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
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
  createdAt: string;
}

export interface MessagesPaginationResponseDto {
  messages: MessageResponseDto[];
  hasMore: boolean;
  nextCursor?: string;
}
