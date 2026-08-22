import type { MessagePayload } from '../../../shared/socket-events';

export const CHAT_EVENTS = {
  MESSAGE_CREATED: 'chat.message.created',
  MESSAGE_UPDATED: 'chat.message.updated',
  MESSAGE_DELETED: 'chat.message.deleted',
  MESSAGE_READ: 'chat.message.read',
} as const;

export interface MessageCreatedEvent {
  conversationId: string | null;
  channelId: string | null;
  message: MessagePayload;
}

export interface MessageUpdatedEvent {
  conversationId: string | null;
  channelId: string | null;
  message: MessagePayload;
}

export interface MessageDeletedEvent {
  conversationId: string | null;
  channelId: string | null;
  messageId: string;
}

export interface MessageReadEvent {
  conversationId: string;
  userId: string;
  lastReadMessageId: string;
}
