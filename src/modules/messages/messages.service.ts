import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from '../conversations/conversations.service';
import type { EditMessageDto } from './dto/edit-message.dto';
import type { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import type {
  MessageAuthorDto,
  MessageResponseDto,
  MessagesPaginationResponseDto,
} from './dto/message-response.dto';
import type { SendMessageDto } from './dto/send-message.dto';

interface RawMessageRow {
  id: number | string;
  channel_id: string | null;
  conversation_id: string | null;
  author_id: string | null;
  type: 'default' | 'system_join' | 'system_leave';
  content: string | null;
  reply_to_id: number | string | null;
  client_nonce: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface RawProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conversationsService: ConversationsService,
  ) {}

  /**
   * Lấy lịch sử tin nhắn của cuộc trò chuyện dùng Cursor Pagination.
   */
  async getConversationMessages(
    userId: string,
    conversationId: string,
    query: GetMessagesQueryDto,
  ): Promise<MessagesPaginationResponseDto> {
    const isMember = await this.conversationsService.verifyMembership(
      userId,
      conversationId,
    );
    if (!isMember) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của cuộc trò chuyện này.',
      );
    }

    const limit = query.limit ?? 50;

    let q = this.supabase.client
      .from('messages')
      .select(
        'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .eq('conversation_id', conversationId);

    if (query.before) {
      q = q.lt('id', query.before);
    }
    if (query.after) {
      q = q.gt('id', query.after);
    }

    // Lấy dư 1 bản ghi để kiểm tra hasMore
    q = q.order('id', { ascending: false }).limit(limit + 1);

    const { data: rawMessages, error } = await q;

    if (error) {
      this.logger.error('Lỗi tải tin nhắn:', error);
      throw new InternalServerErrorException('Lỗi tải lịch sử tin nhắn.');
    }

    const messagesList = (rawMessages ?? []) as RawMessageRow[];
    const hasMore = messagesList.length > limit;
    const finalRows = hasMore ? messagesList.slice(0, limit) : messagesList;

    // Lấy thông tin profiles của các tác giả
    const authorIds = Array.from(
      new Set(
        finalRows
          .map((m) => m.author_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const authorMap = new Map<string, MessageAuthorDto>();
    if (authorIds.length > 0) {
      const { data: profiles } = await this.supabase.client
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .in('id', authorIds);

      for (const p of (profiles ?? []) as RawProfileRow[]) {
        authorMap.set(p.id, {
          id: p.id,
          username: p.username,
          displayName: p.display_name ?? p.username,
          avatarUrl: p.avatar_url,
        });
      }
    }

    const formattedMessages: MessageResponseDto[] = finalRows.map((m) => ({
      id: m.id.toString(),
      channelId: m.channel_id,
      conversationId: m.conversation_id,
      authorId: m.author_id,
      author: m.author_id ? authorMap.get(m.author_id) : undefined,
      type: m.type,
      content: m.deleted_at ? null : m.content,
      replyToId: m.reply_to_id ? m.reply_to_id.toString() : null,
      clientNonce: m.client_nonce,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      createdAt: m.created_at,
    }));

    const nextCursor =
      hasMore && finalRows.length > 0
        ? finalRows[finalRows.length - 1].id.toString()
        : undefined;

    return {
      messages: formattedMessages,
      hasMore,
      nextCursor,
    };
  }

  /**
   * Gửi tin nhắn mới vào cuộc trò chuyện.
   */
  async createConversationMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<MessageResponseDto> {
    const isMember = await this.conversationsService.verifyMembership(
      userId,
      conversationId,
    );
    if (!isMember) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của cuộc trò chuyện này.',
      );
    }

    const text = dto.content.trim();
    if (!text) {
      throw new BadRequestException('Nội dung tin nhắn không được để trống.');
    }

    // 1. Kiểm tra idempotency qua clientNonce (nếu có)
    if (dto.clientNonce) {
      const { data: existing } = await this.supabase.client
        .from('messages')
        .select(
          'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
        )
        .eq('author_id', userId)
        .eq('client_nonce', dto.clientNonce)
        .maybeSingle();

      if (existing) {
        const raw = existing as RawMessageRow;
        const author = await this.getAuthorProfile(userId);
        return {
          id: raw.id.toString(),
          channelId: raw.channel_id,
          conversationId: raw.conversation_id,
          authorId: raw.author_id,
          author,
          type: raw.type,
          content: raw.deleted_at ? null : raw.content,
          replyToId: raw.reply_to_id ? raw.reply_to_id.toString() : null,
          clientNonce: raw.client_nonce,
          editedAt: raw.edited_at,
          deletedAt: raw.deleted_at,
          createdAt: raw.created_at,
        };
      }
    }

    // 2. Chèn tin nhắn mới vào bảng messages
    const { data: newMsg, error: insertErr } = await this.supabase.client
      .from('messages')
      .insert({
        conversation_id: conversationId,
        author_id: userId,
        content: text,
        client_nonce: dto.clientNonce ?? null,
        reply_to_id: dto.replyToId ? Number(dto.replyToId) : null,
      })
      .select(
        'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .single();

    if (insertErr || !newMsg) {
      this.logger.error('Lỗi chèn tin nhắn:', insertErr);
      throw new InternalServerErrorException('Không thể gửi tin nhắn.');
    }

    const raw = newMsg as RawMessageRow;
    const author = await this.getAuthorProfile(userId);

    return {
      id: raw.id.toString(),
      channelId: raw.channel_id,
      conversationId: raw.conversation_id,
      authorId: raw.author_id,
      author,
      type: raw.type,
      content: raw.deleted_at ? null : raw.content,
      replyToId: raw.reply_to_id ? raw.reply_to_id.toString() : null,
      clientNonce: raw.client_nonce,
      editedAt: raw.edited_at,
      deletedAt: raw.deleted_at,
      createdAt: raw.created_at,
    };
  }

  /**
   * Chỉnh sửa tin nhắn (chỉ cho phép chính tác giả).
   */
  async editMessage(
    userId: string,
    messageId: string,
    dto: EditMessageDto,
  ): Promise<MessageResponseDto> {
    const text = dto.content.trim();
    if (!text) {
      throw new BadRequestException('Nội dung tin nhắn không được để trống.');
    }

    const { data: existing, error: findErr } = await this.supabase.client
      .from('messages')
      .select(
        'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .eq('id', messageId)
      .maybeSingle();

    if (findErr || !existing) {
      throw new NotFoundException('Không tìm thấy tin nhắn.');
    }

    const raw = existing as RawMessageRow;
    if (raw.author_id !== userId) {
      throw new ForbiddenException(
        'Bạn chỉ có thể chỉnh sửa tin nhắn của chính mình.',
      );
    }

    if (raw.deleted_at) {
      throw new BadRequestException('Tin nhắn đã bị xoá, không thể chỉnh sửa.');
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateErr } = await this.supabase.client
      .from('messages')
      .update({
        content: text,
        edited_at: now,
      })
      .eq('id', messageId)
      .select(
        'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .single();

    if (updateErr || !updated) {
      this.logger.error('Lỗi cập nhật tin nhắn:', updateErr);
      throw new InternalServerErrorException('Lỗi cập nhật tin nhắn.');
    }

    const rawUpdated = updated as RawMessageRow;
    const author = await this.getAuthorProfile(userId);

    return {
      id: rawUpdated.id.toString(),
      channelId: rawUpdated.channel_id,
      conversationId: rawUpdated.conversation_id,
      authorId: rawUpdated.author_id,
      author,
      type: rawUpdated.type,
      content: rawUpdated.content,
      replyToId: rawUpdated.reply_to_id
        ? rawUpdated.reply_to_id.toString()
        : null,
      clientNonce: rawUpdated.client_nonce,
      editedAt: rawUpdated.edited_at,
      deletedAt: rawUpdated.deleted_at,
      createdAt: rawUpdated.created_at,
    };
  }

  /**
   * Xoá tin nhắn (soft delete: set deleted_at = now()).
   */
  async deleteMessage(
    userId: string,
    messageId: string,
  ): Promise<{ id: string; deleted: boolean; conversationId: string | null }> {
    const { data: existing, error: findErr } = await this.supabase.client
      .from('messages')
      .select('id, conversation_id, author_id, deleted_at')
      .eq('id', messageId)
      .maybeSingle();

    if (findErr || !existing) {
      throw new NotFoundException('Không tìm thấy tin nhắn.');
    }

    const raw = existing as RawMessageRow;
    if (raw.author_id !== userId) {
      throw new ForbiddenException(
        'Bạn chỉ có thể xoá tin nhắn của chính mình.',
      );
    }

    const now = new Date().toISOString();
    const { error: delErr } = await this.supabase.client
      .from('messages')
      .update({
        content: null,
        deleted_at: now,
      })
      .eq('id', messageId);

    if (delErr) {
      this.logger.error('Lỗi xoá tin nhắn:', delErr);
      throw new InternalServerErrorException('Lỗi xoá tin nhắn.');
    }

    return {
      id: messageId,
      deleted: true,
      conversationId: raw.conversation_id,
    };
  }

  /**
   * Đánh dấu đã đọc tin nhắn trong cuộc trò chuyện.
   */
  async markAsRead(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ success: boolean }> {
    const isMember = await this.conversationsService.verifyMembership(
      userId,
      conversationId,
    );
    if (!isMember) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên của cuộc trò chuyện này.',
      );
    }

    const { error } = await this.supabase.client.from('read_states').upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        last_read_message_id: Number(messageId),
        mention_count: 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,conversation_id' },
    );

    if (error) {
      this.logger.error('Lỗi cập nhật read_states:', error);
      throw new InternalServerErrorException('Lỗi cập nhật trạng thái đọc.');
    }

    return { success: true };
  }

  private async getAuthorProfile(
    authorId: string,
  ): Promise<MessageAuthorDto | undefined> {
    const { data } = await this.supabase.client
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('id', authorId)
      .maybeSingle();

    if (!data) return undefined;
    const raw = data as RawProfileRow;
    return {
      id: raw.id,
      username: raw.username,
      displayName: raw.display_name ?? raw.username,
      avatarUrl: raw.avatar_url,
    };
  }
}
