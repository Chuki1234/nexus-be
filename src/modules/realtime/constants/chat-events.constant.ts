import type { MessagePayload, BlockedUserDto } from '../../../shared';

export const CHAT_EVENTS = {
  MESSAGE_CREATED: 'chat.message.created',
  MESSAGE_UPDATED: 'chat.message.updated',
  MESSAGE_DELETED: 'chat.message.deleted',
  MESSAGE_HIDDEN_FOR_USER: 'chat.message.hidden_for_user',
  MESSAGE_READ: 'chat.message.read',
  MESSAGE_PIN_UPDATED: 'chat.message.pin_updated',
  REACTION_UPDATED: 'chat.reaction.updated',
  CONVERSATION_DELETED: 'chat.conversation.deleted',
  USER_BLOCK_CREATED: 'user.block.created',
  USER_BLOCK_REMOVED: 'user.block.removed',
  RELATIONSHIP_INVALIDATED: 'relationship.invalidated',
  DIRECT_CALL_TERMINATED: 'direct_call.terminated',
  FRIEND_REQUEST_RECEIVED: 'friend.request.received',
  SERVER_MEMBER_JOINED: 'server.member.joined',
  SERVER_MEMBER_LEFT: 'server.member.left',
} as const;

export interface ServerMemberJoinedEvent {
  serverId: string;
  userId: string;
}

export interface ServerMemberLeftEvent {
  serverId: string;
  userId: string;
}

export interface FriendRequestReceivedEvent {
  recipientId: string;
  requesterId: string;
  createdAt: string;
}

export interface ConversationDeletedEvent {
  conversationId: string;
  userId: string;
  friendId: string;
}

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

export interface UserBlockCreatedEvent {
  blockerId: string;
  blockedUser: BlockedUserDto;
}

export interface UserBlockRemovedEvent {
  blockerId: string;
  blockedUserId: string;
}

export interface RelationshipInvalidatedEvent {
  targetUserId: string;
  invalidatedWithUserId: string;
}
