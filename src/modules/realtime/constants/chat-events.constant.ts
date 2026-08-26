import type { MessagePayload } from '../../../shared/socket-events';

export const CHAT_EVENTS = {
  MESSAGE_CREATED: 'chat.message.created',
  MESSAGE_UPDATED: 'chat.message.updated',
  MESSAGE_DELETED: 'chat.message.deleted',
  MESSAGE_HIDDEN_FOR_USER: 'chat.message.hidden_for_user',
  MESSAGE_READ: 'chat.message.read',
  MESSAGE_PIN_UPDATED: 'chat.message.pin_updated',
  REACTION_UPDATED: 'chat.reaction.updated',
} as const;

export interface MessageHiddenForUserEvent {
  userId: string;
  messageId: string;
  conversationId: string | null;
  channelId: string | null;
}

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
  conversationId: string | null;
  channelId: string | null;
  userId: string;
  readerId?: string;
  lastReadMessageId: string;
}

export interface ReactionUpdatedEvent {
  conversationId: string | null;
  channelId: string | null;
  messageId: string;
  actorUserId: string;
  emoji: string;
  action: 'added' | 'removed';
  clientMutationId?: string;
  reactions: Array<{ emoji: string; count: number }>;
}
