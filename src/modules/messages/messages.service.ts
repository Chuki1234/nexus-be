import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ServerPermissionsService } from '../servers/server-permissions.service';
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';
import { Permission } from '../../shared/permissions';
import type { EditMessageDto } from './dto/edit-message.dto';
import type { ForwardMessageDto } from './dto/forward-message.dto';
import type { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import type {
  AttachmentResponseDto,
  ChannelMessagesResponseDto,
  MessageAuthorDto,
  MessageResponseDto,
  MessagesPaginationResponseDto,
  ReactionSummaryDto,
} from './dto/message-response.dto';
import type { SendMessageDto } from './dto/send-message.dto';
import type { SetReactionDto } from './dto/set-reaction.dto';
import type { GiphyMediaDto } from '../../shared/dto/messages.dto';
import { validateAndSanitizeGiphyMedia } from './validators/giphy-media.validator';

interface RawMessageRow {
  id: number | string;
  channel_id: string | null;
  conversation_id: string | null;
  author_id: string | null;
  type: 'default' | 'system_join' | 'system_leave';
  content: string | null;
  is_forwarded?: boolean | null;
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

interface RawAttachmentRow {
  id: string;
  message_id: number | string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  width: number | null;
  height: number | null;
  created_at: string;
}

import { validateDocxBuffer } from './utils/docx-validator.util';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

function checkMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) return false;
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  if (mimeType === 'image/gif') {
    return (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  if (mimeType === 'application/pdf') {
    return buffer.toString('ascii', 0, 4) === '%PDF';
  }
  if (
    mimeType === 'application/zip' ||
    mimeType === 'application/x-zip-compressed'
  ) {
    return (
      (buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04) ||
      (buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x05 &&
        buffer[3] === 0x06)
    );
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return validateDocxBuffer(buffer).valid;
  }
  if (mimeType === 'text/plain') {
    return !buffer.includes(0x00);
  }
  return false;
}

/**
 * Chuẩn hoá tên tập tin:
 * 1. Nhận diện và giải mã an toàn các byte-sequence Latin-1 bị sinh ra do parser multipart không nhận UTF-8.
 * 2. Idempotent: chạy nhiều lần trên cùng 1 chuỗi không làm biến đổi chuỗi đã chuẩn.
 * 3. Bảo toàn nguyên vẹn Unicode tiếng Việt, Emoji và ASCII.
 * 4. Loại bỏ path traversal và control characters nguy hiểm.
 */
export function normalizeFilename(rawName: string): string {
  if (!rawName) return 'attachment';
  let cleaned = rawName;

  // Heuristic: Kiểm tra nếu chuỗi có dấu hiệu mojibake UTF-8 được giải mã nhầm qua Latin-1
  if (/[\xC0-\xFF]/.test(rawName)) {
    try {
      const candidate = Buffer.from(rawName, 'latin1').toString('utf8');
      // Chỉ chọn candidate nếu decode thành công (không có ký tự thay thế \uFFFD)
      // và candidate khác với rawName
      if (!candidate.includes('\uFFFD') && candidate !== rawName) {
        // Kiểm tra tính đối xứng (round-trip check) để không vô tình sửa chuỗi hợp lệ
        const reEncoded = Buffer.from(candidate, 'utf8').toString('latin1');
        if (reEncoded === rawName) {
          cleaned = candidate;
        }
      }
    } catch {
      // Giữ nguyên chuỗi gốc nếu có lỗi
    }
  }

  // Tách lấy base filename (chống path traversal ../)
  const base = cleaned.split(/[/\\]/).pop() || 'attachment';
  // Lọc bỏ ký tự điều khiển ASCII và DEL (\x00-\x1F, \x7F) nhưng BẢO TOÀN toàn bộ Unicode tiếng Việt & Emoji
  const sanitized = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return sanitized.slice(0, 255) || 'attachment';
}

/**
 * Định dạng header Content-Disposition tuân thủ RFC 5987 / RFC 6266.
 * Hỗ trợ tải file có tên tiếng Việt / Emoji an toàn và chống CRLF injection.
 */
export function formatContentDisposition(filename: string): string {
  const safeFilename = filename.replace(/[\r\n"]/g, '_').trim();
  const asciiFallback = safeFilename.replace(/[^\x20-\x7E]/g, '_') || 'attachment';
  const utf8Encoded = encodeURIComponent(safeFilename)
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Kiểm tra xem một chuỗi có phải là đúng 1 extended grapheme cluster biểu tượng cảm xúc (emoji) hợp lệ hay không.
 * Cho phép emoji có skin tone modifier, variation selector (\uFE0F) và Zero-Width Joiner (ZWJ).
 * Chặn text thông thường, thẻ HTML, URLs và ký tự điều khiển.
 */
export function isValidEmoji(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  const normalized = str.normalize('NFC').trim();
  if (normalized.length === 0 || normalized.length > 32) return false;

  // Chặn thẻ HTML, URLs, ký tự điều khiển
  if (/[<>\r\n\t\x00-\x1f\x7f]/.test(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) return false;

  // Kiểm tra đúng 1 extended grapheme cluster qua Intl.Segmenter
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(normalized));
    if (segments.length !== 1) return false;
  } catch {
    if (Array.from(normalized).length > 8) return false;
  }

  // Regex kiểm tra ký tự emoji / pictograph / symbol
  const emojiRegex =
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/u;
  return emojiRegex.test(normalized);
}

export interface SetReactionResponseDto {
  messageId: string;
  conversationId?: string | null;
  channelId?: string | null;
  clientMutationId?: string;
  reactions: ReactionSummaryDto[];
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conversationsService: ConversationsService,
    private readonly serverPermissionsService: ServerPermissionsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Lấy lịch sử tin nhắn của cuộc trò chuyện dùng Cursor Pagination kèm attachments.
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

    // 1. Lấy thông tin profiles của các tác giả
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

    // 2. Lấy attachments, reactions & externalMedia cho các tin nhắn chưa bị xoá (deleted_at === null)
    const activeRows = finalRows.filter((m) => !m.deleted_at);
    const activeMessageIds = activeRows.map((m) => m.id);
    const [attachmentMap, reactionMap, extMediaMap] = await Promise.all([
      this.loadAttachmentsForMessages(activeMessageIds),
      this.loadReactionsForMessages(activeMessageIds, userId),
      this.loadExternalMediaForMessages(activeMessageIds),
    ]);

    const formattedMessages: MessageResponseDto[] = finalRows.map((m) => {
      const msgId = m.id.toString();
      const atts = m.deleted_at ? undefined : attachmentMap.get(msgId);
      const reacts = m.deleted_at ? undefined : (reactionMap.get(msgId) ?? []);
      const extMedia = m.deleted_at ? null : (extMediaMap.get(msgId) ?? null);
      return {
        id: msgId,
        channelId: m.channel_id,
        conversationId: m.conversation_id,
        authorId: m.author_id,
        author: m.author_id ? authorMap.get(m.author_id) : undefined,
        type: m.type,
        content: m.deleted_at ? null : m.content,
        isForwarded: Boolean(m.is_forwarded),
        externalMedia: extMedia,
        replyToId: m.reply_to_id ? m.reply_to_id.toString() : null,
        clientNonce: m.client_nonce,
        editedAt: m.edited_at,
        deletedAt: m.deleted_at,
        ...(atts && atts.length > 0 ? { attachments: atts } : {}),
        reactions: reacts,
        createdAt: m.created_at,
      };
    });

    const result: MessagesPaginationResponseDto = {
      messages: formattedMessages,
      hasMore,
    };

    if (hasMore && finalRows.length > 0) {
      result.nextCursor = finalRows[finalRows.length - 1].id.toString();
    }

    return result;
  }

  /**
   * Lấy lịch sử tin nhắn của kênh máy chủ dùng Cursor Pagination kèm attachments và lastReadMessageId.
   */
  async getChannelMessages(
    userId: string,
    channelId: string,
    query: GetMessagesQueryDto,
  ): Promise<ChannelMessagesResponseDto> {
    await this.serverPermissionsService.assertChannelView(userId, channelId);

    const limit = query.limit ?? 50;

    let q = this.supabase.client
      .from('messages')
      .select(
        'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .eq('channel_id', channelId);

    if (query.before) {
      q = q.lt('id', query.before);
    } else if (query.after) {
      q = q.gt('id', query.after);
    }

    q = q.order('id', { ascending: false }).limit(limit + 1);

    const { data: rawMessages, error: msgError } = await q;
    if (msgError) {
      this.logger.error('Lỗi lấy tin nhắn kênh:', msgError);
      throw new InternalServerErrorException('Lỗi tải tin nhắn kênh.');
    }

    const messages = (rawMessages || []) as RawMessageRow[];
    const hasMore = messages.length > limit;
    const finalRows = hasMore ? messages.slice(0, limit) : messages;

    // 1. Lấy author profiles
    const authorIds = Array.from(
      new Set(finalRows.map((m) => m.author_id).filter((id): id is string => !!id)),
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

    // 2. Lấy attachments, reactions & externalMedia cho tin nhắn chưa bị xóa
    const activeRows = finalRows.filter((m) => !m.deleted_at);
    const activeMessageIds = activeRows.map((m) => m.id);
    const [attachmentMap, reactionMap, extMediaMap] = await Promise.all([
      this.loadAttachmentsForMessages(activeMessageIds),
      this.loadReactionsForMessages(activeMessageIds, userId),
      this.loadExternalMediaForMessages(activeMessageIds),
    ]);

    // 3. Lấy read state của user trên channel này
    const { data: readState } = await this.supabase.client
      .from('read_states')
      .select('last_read_message_id')
      .eq('user_id', userId)
      .eq('channel_id', channelId)
      .maybeSingle();

    const lastReadMessageId = readState?.last_read_message_id
      ? readState.last_read_message_id.toString()
      : null;

    const formattedMessages: MessageResponseDto[] = finalRows.map((m) => {
      const msgId = m.id.toString();
      const atts = m.deleted_at ? undefined : attachmentMap.get(msgId);
      const reacts = m.deleted_at ? undefined : (reactionMap.get(msgId) ?? []);
      const extMedia = m.deleted_at ? null : (extMediaMap.get(msgId) ?? null);
      return {
        id: msgId,
        channelId: m.channel_id,
        conversationId: m.conversation_id,
        authorId: m.author_id,
        author: m.author_id ? authorMap.get(m.author_id) : undefined,
        type: m.type,
        content: m.deleted_at ? null : m.content,
        isForwarded: Boolean(m.is_forwarded),
        externalMedia: extMedia,
        replyToId: m.reply_to_id ? m.reply_to_id.toString() : null,
        clientNonce: m.client_nonce,
        editedAt: m.edited_at,
        deletedAt: m.deleted_at,
        ...(atts && atts.length > 0 ? { attachments: atts } : {}),
        reactions: reacts,
        createdAt: m.created_at,
      };
    });

    const result: ChannelMessagesResponseDto = {
      messages: formattedMessages,
      hasMore,
      lastReadMessageId,
    };

    if (hasMore && finalRows.length > 0) {
      result.nextCursor = finalRows[finalRows.length - 1].id.toString();
    }

    return result;
  }

  /**
   * Helper tải gộp (batch load) toàn bộ reactions cho danh sách message IDs.
   * Chỉ tốn đúng 1 truy vấn database (O(1) query) không phụ thuộc số lượng tin nhắn.
   */
  private async loadReactionsForMessages(
    messageIds: (number | string)[],
    currentUserId: string,
  ): Promise<Map<string, ReactionSummaryDto[]>> {
    const reactionMap = new Map<string, ReactionSummaryDto[]>();
    if (messageIds.length === 0) return reactionMap;

    const { data: rawReactions, error: reactErr } = await this.supabase.client
      .from('message_reactions')
      .select('message_id, user_id, emoji')
      .in('message_id', messageIds);

    if (reactErr) {
      this.logger.error('Lỗi tải reactions cho tin nhắn:', reactErr);
      return reactionMap;
    }

    if (!rawReactions || rawReactions.length === 0) {
      return reactionMap;
    }

    // message_id -> emoji -> { count, reactedByMe }
    const grouped = new Map<
      string,
      Map<string, { count: number; reactedByMe: boolean }>
    >();

    for (const r of rawReactions as {
      message_id: string | number;
      user_id: string;
      emoji: string;
    }[]) {
      const msgIdStr = r.message_id.toString();
      let emojiMap = grouped.get(msgIdStr);
      if (!emojiMap) {
        emojiMap = new Map();
        grouped.set(msgIdStr, emojiMap);
      }

      const existing = emojiMap.get(r.emoji);
      if (!existing) {
        emojiMap.set(r.emoji, {
          count: 1,
          reactedByMe: r.user_id === currentUserId,
        });
      } else {
        existing.count += 1;
        if (r.user_id === currentUserId) {
          existing.reactedByMe = true;
        }
      }
    }

    for (const [msgId, emojiMap] of grouped.entries()) {
      const summaryList: ReactionSummaryDto[] = [];
      for (const [emoji, stat] of emojiMap.entries()) {
        summaryList.push({
          emoji,
          count: stat.count,
          reactedByMe: stat.reactedByMe,
        });
      }
      reactionMap.set(msgId, summaryList);
    }

    return reactionMap;
  }

  /**
   * Helper tải attachments và tạo Signed URLs cho danh sách message IDs.
   * Tuyệt đối không fallback sang getPublicUrl() cho private bucket.
   */
  private async loadAttachmentsForMessages(
    messageIds: (number | string)[],
  ): Promise<Map<string, AttachmentResponseDto[]>> {
    const attachmentMap = new Map<string, AttachmentResponseDto[]>();
    if (messageIds.length === 0) return attachmentMap;

    const { data: rawAttachments, error: attError } = await this.supabase.client
      .from('attachments')
      .select(
        'id, message_id, storage_path, filename, mime_type, size_bytes, width, height, created_at',
      )
      .in('message_id', messageIds);

    if (attError) {
      this.logger.error('Lỗi tải metadata attachments:', attError);
      return attachmentMap;
    }

    if (!rawAttachments || rawAttachments.length === 0) {
      return attachmentMap;
    }

    const attList = rawAttachments as RawAttachmentRow[];
    const paths = attList.map((a) => a.storage_path);

    const signedMap = new Map<string, string>();
    try {
      const { data: signedData, error: signedErr } =
        await this.supabase.client.storage
          .from('message-attachments')
          .createSignedUrls(paths, 3600);

      if (signedErr) {
        this.logger.error('Lỗi tạo signed URLs cho attachments:', signedErr);
      } else if (signedData) {
        for (const item of signedData) {
          if (item.signedUrl && item.path) {
            signedMap.set(item.path, item.signedUrl);
          }
        }
      }
    } catch (err: unknown) {
      this.logger.error('Ngoại lệ khi tạo signed URLs cho attachments:', err);
    }

    for (const att of attList) {
      const msgIdStr = att.message_id.toString();
      const signedUrl = signedMap.get(att.storage_path) ?? null;

      // Nếu không tạo được signed URL, vẫn giữ metadata đính kèm để UI hiển thị trạng thái "không khả dụng"
      if (!signedUrl) {
        this.logger.warn(
          `Không thể tạo signed URL cho attachment ${att.id} (${att.storage_path}). Giữ metadata hiển thị unavailable.`,
        );
      }

      const dto: AttachmentResponseDto = {
        id: att.id,
        filename: att.filename,
        mimeType: att.mime_type,
        sizeBytes: Number(att.size_bytes),
        width: att.width,
        height: att.height,
        signedUrl,
        isAvailable: !!signedUrl,
      };

      const existing = attachmentMap.get(msgIdStr) || [];
      existing.push(dto);
      attachmentMap.set(msgIdStr, existing);
    }

    return attachmentMap;
  }

  /**
   * Helper tải gộp (batch load) metadata externalMedia (GIPHY) cho danh sách message IDs.
   * O(1) database query, chống N+1 query.
   */
  private async loadExternalMediaForMessages(
    messageIds: (number | string)[],
  ): Promise<Map<string, GiphyMediaDto>> {
    const mediaMap = new Map<string, GiphyMediaDto>();
    if (messageIds.length === 0) return mediaMap;

    const { data: rawMedia, error: mediaErr } = await this.supabase.client
      .from('message_external_media')
      .select(
        'message_id, provider, external_id, media_type, title, creator_username, page_url, preview_url, display_url, mp4_url, width, height',
      )
      .in('message_id', messageIds);

    if (mediaErr) {
      this.logger.error('Lỗi tải metadata externalMedia:', mediaErr);
      return mediaMap;
    }

    if (!rawMedia || rawMedia.length === 0) {
      return mediaMap;
    }

    for (const item of rawMedia as any[]) {
      const msgIdStr = item.message_id.toString();
      mediaMap.set(msgIdStr, {
        provider: item.provider as 'giphy',
        externalId: item.external_id,
        mediaType: item.media_type as 'gif',
        title: item.title || '',
        creatorUsername: item.creator_username,
        pageUrl: item.page_url,
        previewUrl: item.preview_url,
        displayUrl: item.display_url,
        mp4Url: item.mp4_url,
        width: item.width,
        height: item.height,
      });
    }

    return mediaMap;
  }

  /**
   * Gửi tin nhắn mới vào cuộc trò chuyện (hỗ trợ text, tệp đính kèm và ảnh GIF GIPHY).
   * Ghi nhận cơ sở dữ liệu nguyên tử qua PostgreSQL RPC create_conversation_message.
   */
  async createConversationMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
    files?: Express.Multer.File[],
    isForwarded?: boolean,
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

    const text = dto.content?.trim() || null;
    const uploadFiles = files || [];

    let sanitizedMedia: GiphyMediaDto | null = null;
    if (dto.externalMedia) {
      sanitizedMedia = validateAndSanitizeGiphyMedia(dto.externalMedia);
    }

    if (!text && uploadFiles.length === 0 && !sanitizedMedia) {
      throw new BadRequestException(
        'Tin nhắn phải có nội dung văn bản, tệp đính kèm hoặc ảnh GIF.',
      );
    }

    if (uploadFiles.length > 5) {
      throw new BadRequestException(
        'Chỉ được đính kèm tối đa 5 file mỗi tin nhắn.',
      );
    }

    // Validate từng file & an toàn ảnh qua sharp
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_TOTAL_FILE_SIZE = 30 * 1024 * 1024; // 30MB

    const totalBatchSize = uploadFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBatchSize > MAX_TOTAL_FILE_SIZE) {
      throw new BadRequestException(
        'Tổng dung lượng các tệp đính kèm vượt quá giới hạn 30MB.',
      );
    }

    const processedMetadata: {
      file: Express.Multer.File;
      normalizedFilename: string;
      width: number | null;
      height: number | null;
      ext: string;
    }[] = [];

    for (const f of uploadFiles) {
      const normalizedFilename = normalizeFilename(f.originalname);

      if (f.size > MAX_FILE_SIZE) {
        throw new BadRequestException(
          `File "${normalizedFilename}" vượt quá dung lượng tối đa 10MB.`,
        );
      }

      if (!ALLOWED_MIME_TYPES.has(f.mimetype)) {
        throw new BadRequestException(
          `Định dạng file "${f.mimetype}" không được hỗ trợ.`,
        );
      }

      if (f.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const docxCheck = validateDocxBuffer(f.buffer);
        if (!docxCheck.valid) {
          throw new BadRequestException(
            `Tệp "${normalizedFilename}" không phải là tài liệu Word (.docx) hợp lệ: ${docxCheck.reason}`,
          );
        }
      } else if (!checkMagicBytes(f.buffer, f.mimetype)) {
        throw new BadRequestException(
          `Tệp "${normalizedFilename}" có nội dung không khớp với định dạng ${f.mimetype}.`,
        );
      }

      let width: number | null = null;
      let height: number | null = null;

      if (f.mimetype.startsWith('image/')) {
        try {
          const isAnimated =
            f.mimetype === 'image/gif' || f.mimetype === 'image/webp';
          const image = sharp(f.buffer, {
            limitInputPixels: 100_000_000,
            animated: isAnimated,
          });
          const meta = await image.metadata();

          const frameWidth = meta.width ?? null;
          const framePages =
            isAnimated && meta.pages && meta.pages > 0 ? meta.pages : 1;
          const frameHeight =
            isAnimated && meta.pageHeight
              ? meta.pageHeight
              : meta.height
                ? Math.floor(meta.height / framePages)
                : null;

          if (!frameWidth || !frameHeight) {
            throw new BadRequestException(
              `Không thể đọc kích thước của hình ảnh "${normalizedFilename}".`,
            );
          }

          const MAX_FRAME_DIMENSION = 4096;
          if (
            frameWidth > MAX_FRAME_DIMENSION ||
            frameHeight > MAX_FRAME_DIMENSION
          ) {
            throw new BadRequestException(
              `Kích thước khung hình "${normalizedFilename}" (${frameWidth}x${frameHeight}px) vượt quá giới hạn tối đa ${MAX_FRAME_DIMENSION}x${MAX_FRAME_DIMENSION}px.`,
            );
          }

          const MAX_FRAME_COUNT = 300;
          if (framePages > MAX_FRAME_COUNT) {
            throw new BadRequestException(
              `Ảnh động "${normalizedFilename}" có ${framePages} khung hình, vượt quá giới hạn cho phép (tối đa ${MAX_FRAME_COUNT} frames).`,
            );
          }

          const MAX_PER_FRAME_PIXELS = 25_000_000;
          if (frameWidth * frameHeight > MAX_PER_FRAME_PIXELS) {
            throw new BadRequestException(
              `Kích thước giải nén của khung hình "${normalizedFilename}" vượt quá giới hạn cho phép (tối đa 25 Megapixels/frame).`,
            );
          }

          const MAX_TOTAL_DECODED_PIXELS = 100_000_000;
          const totalDecodedPixels = frameWidth * frameHeight * framePages;
          if (totalDecodedPixels > MAX_TOTAL_DECODED_PIXELS) {
            throw new BadRequestException(
              `Tổng kích thước giải nén của ảnh động "${normalizedFilename}" vượt quá ngân sách tài nguyên cho phép (tối đa 100 Megapixels).`,
            );
          }

          width = frameWidth;
          height = frameHeight;
        } catch (err: unknown) {
          if (err instanceof BadRequestException) {
            throw err;
          }
          throw new BadRequestException(
            `Hình ảnh "${normalizedFilename}" bị lỗi, hỏng hoặc không thể xử lý.`,
          );
        }
      }

      const ext = MIME_EXTENSION_MAP[f.mimetype] || '';
      processedMetadata.push({
        file: f,
        normalizedFilename,
        width,
        height,
        ext,
      });
    }

    // 1. Kiểm tra replyToId nếu có
    if (dto.replyToId) {
      const { data: replyTarget, error: replyErr } = await this.supabase.client
        .from('messages')
        .select('id, conversation_id, deleted_at')
        .eq('id', dto.replyToId)
        .maybeSingle();

      if (replyErr || !replyTarget) {
        throw new BadRequestException('Tin nhắn được trả lời không tồn tại.');
      }
      if (replyTarget.conversation_id !== conversationId) {
        throw new BadRequestException(
          'Tin nhắn được trả lời không thuộc cuộc trò chuyện này.',
        );
      }
    }

    // 2. Kiểm tra idempotency trước khi upload file
    if (dto.clientNonce) {
      const { data: existing } = await this.supabase.client
        .from('messages')
        .select(
          'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
        )
        .eq('author_id', userId)
        .eq('client_nonce', dto.clientNonce)
        .maybeSingle();

      if (existing) {
        const raw = existing as RawMessageRow;
        if (raw.conversation_id !== conversationId) {
          throw new ConflictException(
            'Client nonce đã được sử dụng cho cuộc trò chuyện khác.',
          );
        }
        const author = await this.getAuthorProfile(userId);
        const [attMap, extMediaMap] = await Promise.all([
          this.loadAttachmentsForMessages([raw.id]),
          this.loadExternalMediaForMessages([raw.id]),
        ]);
        const existingAtts = attMap.get(raw.id.toString());
        const existingMedia = extMediaMap.get(raw.id.toString()) || null;

        return {
          id: raw.id.toString(),
          channelId: raw.channel_id,
          conversationId: raw.conversation_id,
          authorId: raw.author_id,
          author,
          type: raw.type,
          content: raw.deleted_at ? null : raw.content,
          isForwarded: Boolean(raw.is_forwarded),
          externalMedia: existingMedia,
          replyToId: raw.reply_to_id ? raw.reply_to_id.toString() : null,
          clientNonce: raw.client_nonce,
          editedAt: raw.edited_at,
          deletedAt: raw.deleted_at,
          ...(existingAtts && existingAtts.length > 0
            ? { attachments: existingAtts }
            : {}),
          reactions: [],
          createdAt: raw.created_at,
        };
      }
    }

    // 3. Upload file lên Storage (Message Attachments Bucket)
    const uploadedPaths: string[] = [];
    const attachmentsToRpc: any[] = [];
    try {
      for (const item of processedMetadata) {
        const uniqueId = crypto.randomUUID();
        const storagePath = `conversations/${conversationId}/${uniqueId}${item.ext}`;

        const { error: uploadErr } = await this.supabase.client.storage
          .from('message-attachments')
          .upload(storagePath, item.file.buffer, {
            contentType: item.file.mimetype,
            upsert: false,
          });

        if (uploadErr) {
          this.logger.error('Lỗi upload file lên Storage:', uploadErr);
          throw uploadErr;
        }

        uploadedPaths.push(storagePath);
        attachmentsToRpc.push({
          storage_path: storagePath,
          filename: item.normalizedFilename,
          mime_type: item.file.mimetype,
          size_bytes: item.file.size,
          width: item.width,
          height: item.height,
        });
      }
    } catch (uploadErr) {
      if (uploadedPaths.length > 0) {
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
      }
      throw new InternalServerErrorException(
        'Lỗi lưu trữ tập tin đính kèm. Vui lòng thử lại.',
      );
    }

    const nonce = dto.clientNonce || crypto.randomUUID();

    // 3. Ghi DB nguyên tử qua RPC create_conversation_message
    const { data: rpcData, error: rpcErr } = await this.supabase.client.rpc(
      'create_conversation_message',
      {
        p_conversation_id: conversationId,
        p_author_id: userId,
        p_content: text,
        p_client_nonce: nonce,
        p_reply_to_id: dto.replyToId ? BigInt(dto.replyToId) : null,
        p_attachments: attachmentsToRpc,
        p_is_forwarded: Boolean(isForwarded),
        p_external_media: sanitizedMedia,
      },
    );

    if (rpcErr) {
      this.logger.error(
        `RPC create_conversation_message thất bại: ${rpcErr.message} (code: ${rpcErr.code})`,
      );

      if (uploadedPaths.length > 0) {
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
      }

      if (rpcErr.code === '23505') {
        if (nonce) {
          const { data: canonical } = await this.supabase.client
            .from('messages')
            .select(
              'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
            )
            .eq('author_id', userId)
            .eq('client_nonce', nonce)
            .maybeSingle();

          if (canonical) {
            const rawCanonical = canonical as RawMessageRow;
            if (rawCanonical.conversation_id === conversationId) {
              const author = await this.getAuthorProfile(userId);
              const [attMap, extMediaMap] = await Promise.all([
                this.loadAttachmentsForMessages([rawCanonical.id]),
                this.loadExternalMediaForMessages([rawCanonical.id]),
              ]);
              const existingAtts = attMap.get(rawCanonical.id.toString()) || [];
              const existingMedia = extMediaMap.get(rawCanonical.id.toString()) || null;

              return {
                id: rawCanonical.id.toString(),
                channelId: null,
                conversationId: rawCanonical.conversation_id,
                authorId: rawCanonical.author_id,
                author,
                type: rawCanonical.type,
                content: rawCanonical.deleted_at ? null : rawCanonical.content,
                isForwarded: Boolean(rawCanonical.is_forwarded),
                externalMedia: existingMedia,
                replyToId: rawCanonical.reply_to_id
                  ? rawCanonical.reply_to_id.toString()
                  : null,
                clientNonce: rawCanonical.client_nonce,
                editedAt: rawCanonical.edited_at,
                deletedAt: rawCanonical.deleted_at,
                ...(existingAtts.length > 0 ? { attachments: existingAtts } : {}),
                reactions: [],
                createdAt: rawCanonical.created_at,
              };
            }
          }
        }

        throw new ConflictException(
          'Client nonce đã được sử dụng cho cuộc trò chuyện khác.',
        );
      }
      if (rpcErr.code === '42501') {
        throw new ForbiddenException(rpcErr.message);
      }
      if (rpcErr.code === 'P0002') {
        throw new NotFoundException(rpcErr.message);
      }
      if (rpcErr.code === '22023') {
        throw new BadRequestException(rpcErr.message);
      }

      throw new InternalServerErrorException('Lỗi gửi tin nhắn vào cuộc trò chuyện.');
    }

    // 4. Sinh signed URLs cho attachments
    const msgId = rpcData?.id ? String(rpcData.id) : '';
    const attMap = await this.loadAttachmentsForMessages([msgId]);
    const attachmentDtos = attMap.get(msgId) || [];
    const author = await this.getAuthorProfile(userId);

    const result: MessageResponseDto = {
      id: msgId,
      channelId: null,
      conversationId: rpcData?.conversationId || rpcData?.conversation_id || conversationId,
      authorId: rpcData?.authorId || rpcData?.author_id || userId,
      author,
      type: rpcData?.type || 'default',
      content: rpcData?.content !== undefined ? rpcData.content : text,
      isForwarded: Boolean(rpcData?.isForwarded ?? rpcData?.is_forwarded ?? isForwarded),
      externalMedia: (rpcData?.externalMedia as GiphyMediaDto) || (rpcData?.external_media as GiphyMediaDto) || sanitizedMedia || null,
      replyToId: rpcData?.replyToId ? String(rpcData.replyToId) : rpcData?.reply_to_id ? String(rpcData.reply_to_id) : (dto.replyToId || null),
      clientNonce: rpcData?.clientNonce || rpcData?.client_nonce || nonce,
      editedAt: null,
      deletedAt: null,
      ...(attachmentDtos.length > 0 ? { attachments: attachmentDtos } : {}),
      reactions: [],
      createdAt: rpcData?.createdAt || rpcData?.created_at || new Date().toISOString(),
    };

    // 5. Phát sự kiện realtime (chỉ phát khi tin nhắn mới được tạo, không phát lại khi idempotent replay)
    if (!rpcData?.isDuplicate && !rpcData?.is_duplicate) {
      this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_CREATED, {
        conversationId,
        channelId: null,
        message: result,
      });
    }

    return result;
  }

  /**
   * Gửi tin nhắn mới vào kênh máy chủ qua PostgreSQL RPC nguyên tử create_channel_message.
   */
  async createChannelMessage(
    userId: string,
    channelId: string,
    dto: SendMessageDto,
    files?: Express.Multer.File[],
    isForwarded?: boolean,
  ): Promise<MessageResponseDto> {
    await this.serverPermissionsService.assertChannelSend(userId, channelId);

    const text = dto.content?.trim() || null;
    const uploadFiles = files || [];

    let sanitizedMedia: GiphyMediaDto | null = null;
    if (dto.externalMedia) {
      sanitizedMedia = validateAndSanitizeGiphyMedia(dto.externalMedia);
    }

    if (!text && uploadFiles.length === 0 && !sanitizedMedia) {
      throw new BadRequestException(
        'Tin nhắn phải có nội dung văn bản, tệp đính kèm hoặc ảnh GIF.',
      );
    }

    if (uploadFiles.length > 0) {
      await this.serverPermissionsService.assertChannelAttach(userId, channelId);
    }

    if (uploadFiles.length > 5) {
      throw new BadRequestException(
        'Chỉ được đính kèm tối đa 5 file mỗi tin nhắn.',
      );
    }

    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_TOTAL_FILE_SIZE = 30 * 1024 * 1024; // 30MB

    const totalBatchSize = uploadFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBatchSize > MAX_TOTAL_FILE_SIZE) {
      throw new BadRequestException(
        'Tổng dung lượng các file đính kèm không được vượt quá 30MB.',
      );
    }

    const processedMetadata: {
      file: Express.Multer.File;
      normalizedFilename: string;
      width: number | null;
      height: number | null;
      ext: string;
    }[] = [];

    for (const f of uploadFiles) {
      if (!ALLOWED_MIME_TYPES.has(f.mimetype)) {
        throw new BadRequestException(
          `Định dạng file không được hỗ trợ: ${f.mimetype}`,
        );
      }
      if (f.size > MAX_FILE_SIZE) {
        throw new BadRequestException(
          `File "${f.originalname}" vượt quá dung lượng tối đa 10MB.`,
        );
      }
      if (!checkMagicBytes(f.buffer, f.mimetype)) {
        throw new BadRequestException(
          `Nội dung file "${f.originalname}" không khớp với định dạng ${f.mimetype}.`,
        );
      }

      const normalizedFilename = normalizeFilename(f.originalname);
      let width: number | null = null;
      let height: number | null = null;

      if (f.mimetype.startsWith('image/')) {
        try {
          const isAnimated =
            f.mimetype === 'image/gif' || f.mimetype === 'image/webp';
          const image = sharp(f.buffer, {
            limitInputPixels: 100_000_000,
            animated: isAnimated,
          });
          const meta = await image.metadata();

          const frameWidth = meta.width ?? null;
          const framePages =
            isAnimated && meta.pages && meta.pages > 0 ? meta.pages : 1;
          const frameHeight =
            isAnimated && meta.pageHeight
              ? meta.pageHeight
              : meta.height
                ? Math.floor(meta.height / framePages)
                : null;

          if (!frameWidth || !frameHeight) {
            throw new BadRequestException(
              `Không thể đọc kích thước của hình ảnh "${normalizedFilename}".`,
            );
          }

          const MAX_FRAME_DIMENSION = 4096;
          if (
            frameWidth > MAX_FRAME_DIMENSION ||
            frameHeight > MAX_FRAME_DIMENSION
          ) {
            throw new BadRequestException(
              `Kích thước khung hình "${normalizedFilename}" (${frameWidth}x${frameHeight}px) vượt quá giới hạn tối đa ${MAX_FRAME_DIMENSION}x${MAX_FRAME_DIMENSION}px.`,
            );
          }

          const MAX_FRAME_COUNT = 300;
          if (framePages > MAX_FRAME_COUNT) {
            throw new BadRequestException(
              `Ảnh động "${normalizedFilename}" có ${framePages} khung hình, vượt quá giới hạn cho phép (tối đa ${MAX_FRAME_COUNT} frames).`,
            );
          }

          const MAX_PER_FRAME_PIXELS = 25_000_000;
          if (frameWidth * frameHeight > MAX_PER_FRAME_PIXELS) {
            throw new BadRequestException(
              `Kích thước giải nén của khung hình "${normalizedFilename}" vượt quá giới hạn cho phép (tối đa 25 Megapixels/frame).`,
            );
          }

          const MAX_TOTAL_DECODED_PIXELS = 100_000_000;
          const totalDecodedPixels = frameWidth * frameHeight * framePages;
          if (totalDecodedPixels > MAX_TOTAL_DECODED_PIXELS) {
            throw new BadRequestException(
              `Tổng kích thước giải nén của ảnh động "${normalizedFilename}" vượt quá ngân sách tài nguyên cho phép (tối đa 100 Megapixels).`,
            );
          }

          width = frameWidth;
          height = frameHeight;
        } catch (err: unknown) {
          if (err instanceof BadRequestException) {
            throw err;
          }
          throw new BadRequestException(
            `Hình ảnh "${normalizedFilename}" bị lỗi, hỏng hoặc không thể xử lý.`,
          );
        }
      }

      const ext = MIME_EXTENSION_MAP[f.mimetype] || '';
      processedMetadata.push({
        file: f,
        normalizedFilename,
        width,
        height,
        ext,
      });
    }

    // 1. Kiểm tra idempotency trước khi upload
    if (dto.clientNonce) {
      const { data: existing } = await this.supabase.client
        .from('messages')
        .select(
          'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
        )
        .eq('author_id', userId)
        .eq('client_nonce', dto.clientNonce)
        .maybeSingle();

      if (existing) {
        const raw = existing as RawMessageRow;
        if (raw.channel_id !== channelId) {
          throw new ConflictException(
            'Client nonce đã được sử dụng cho kênh khác.',
          );
        }
        const author = await this.getAuthorProfile(userId);
        const [attMap, extMediaMap] = await Promise.all([
          this.loadAttachmentsForMessages([raw.id]),
          this.loadExternalMediaForMessages([raw.id]),
        ]);
        const existingAtts = attMap.get(raw.id.toString()) || [];
        const existingMedia = extMediaMap.get(raw.id.toString()) || null;

        return {
          id: raw.id.toString(),
          channelId: raw.channel_id,
          conversationId: raw.conversation_id,
          authorId: raw.author_id,
          author,
          type: raw.type,
          content: raw.deleted_at ? null : raw.content,
          isForwarded: Boolean(raw.is_forwarded),
          externalMedia: existingMedia,
          replyToId: raw.reply_to_id ? raw.reply_to_id.toString() : null,
          clientNonce: raw.client_nonce,
          editedAt: raw.edited_at,
          deletedAt: raw.deleted_at,
          ...(existingAtts.length > 0 ? { attachments: existingAtts } : {}),
          reactions: [],
          createdAt: raw.created_at,
        };
      }
    }

    // 2. Upload file lên Storage
    const uploadedPaths: string[] = [];
    const attachmentsToRpc: any[] = [];
    try {
      for (const item of processedMetadata) {
        const uniqueId = crypto.randomUUID();
        const storagePath = `channels/${channelId}/${uniqueId}${item.ext}`;

        const { error: uploadErr } = await this.supabase.client.storage
          .from('message-attachments')
          .upload(storagePath, item.file.buffer, {
            contentType: item.file.mimetype,
            upsert: false,
          });

        if (uploadErr) {
          this.logger.error('Lỗi upload file lên Storage:', uploadErr);
          throw uploadErr;
        }

        uploadedPaths.push(storagePath);
        attachmentsToRpc.push({
          storage_path: storagePath,
          filename: item.normalizedFilename,
          mime_type: item.file.mimetype,
          size_bytes: item.file.size,
          width: item.width,
          height: item.height,
        });
      }
    } catch (uploadEx: any) {
      if (uploadedPaths.length > 0) {
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
      }
      throw new InternalServerErrorException(
        'Lỗi lưu tập tin đính kèm lên hệ thống lưu trữ.',
      );
    }

    const nonce = dto.clientNonce || crypto.randomUUID();

    // 3. Ghi DB nguyên tử qua RPC create_channel_message
    const { data: rpcData, error: rpcErr } = await this.supabase.client.rpc(
      'create_channel_message',
      {
        p_channel_id: channelId,
        p_author_id: userId,
        p_content: text,
        p_client_nonce: nonce,
        p_reply_to_id: dto.replyToId ? BigInt(dto.replyToId) : null,
        p_attachments: attachmentsToRpc,
        p_is_forwarded: Boolean(isForwarded),
        p_external_media: sanitizedMedia,
      },
    );

    if (rpcErr) {
      this.logger.error(
        `RPC create_channel_message thất bại: ${rpcErr.message} (code: ${rpcErr.code})`,
      );

      // Dọn dẹp storage objects của request này
      if (uploadedPaths.length > 0) {
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
      }

      if (rpcErr.code === '23505') {
        // Kiểm tra canonical message khi có race condition concurrent duplicate nonce
        if (nonce) {
          const { data: canonical } = await this.supabase.client
            .from('messages')
            .select(
              'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
            )
            .eq('author_id', userId)
            .eq('client_nonce', nonce)
            .maybeSingle();

          if (canonical) {
            const rawCanonical = canonical as RawMessageRow;
            if (rawCanonical.channel_id === channelId) {
              const author = await this.getAuthorProfile(userId);
              const [attMap, extMediaMap] = await Promise.all([
                this.loadAttachmentsForMessages([rawCanonical.id]),
                this.loadExternalMediaForMessages([rawCanonical.id]),
              ]);
              const existingAtts = attMap.get(rawCanonical.id.toString()) || [];
              const existingMedia = extMediaMap.get(rawCanonical.id.toString()) || null;

              return {
                id: rawCanonical.id.toString(),
                channelId: rawCanonical.channel_id,
                conversationId: rawCanonical.conversation_id,
                authorId: rawCanonical.author_id,
                author,
                type: rawCanonical.type,
                content: rawCanonical.deleted_at ? null : rawCanonical.content,
                isForwarded: Boolean(rawCanonical.is_forwarded),
                externalMedia: existingMedia,
                replyToId: rawCanonical.reply_to_id ? rawCanonical.reply_to_id.toString() : null,
                clientNonce: rawCanonical.client_nonce,
                editedAt: rawCanonical.edited_at,
                deletedAt: rawCanonical.deleted_at,
                ...(existingAtts.length > 0 ? { attachments: existingAtts } : {}),
                reactions: [],
                createdAt: rawCanonical.created_at,
              };
            }
          }
        }

        throw new ConflictException(
          'Client nonce đã được sử dụng cho cuộc trò chuyện hoặc kênh khác.',
        );
      }
      if (rpcErr.code === '42501') {
        throw new ForbiddenException(rpcErr.message);
      }
      if (rpcErr.code === 'P0002') {
        throw new NotFoundException(rpcErr.message);
      }
      if (rpcErr.code === '22023') {
        throw new BadRequestException(rpcErr.message);
      }

      throw new InternalServerErrorException('Lỗi gửi tin nhắn vào kênh.');
    }

    // 4. Sinh signed URLs cho attachments
    const msgId = rpcData?.id ? String(rpcData.id) : '';
    const attMap = await this.loadAttachmentsForMessages([msgId]);
    const attachmentDtos = attMap.get(msgId) || [];

    const author = await this.getAuthorProfile(userId);

    const result: MessageResponseDto = {
      id: msgId,
      channelId: rpcData?.channelId || rpcData?.channel_id || channelId,
      conversationId: null,
      authorId: rpcData?.authorId || rpcData?.author_id || userId,
      author,
      type: rpcData?.type || 'default',
      content: rpcData?.content !== undefined ? rpcData.content : text,
      isForwarded: Boolean(rpcData?.isForwarded ?? rpcData?.is_forwarded ?? isForwarded),
      externalMedia: (rpcData?.externalMedia as GiphyMediaDto) || (rpcData?.external_media as GiphyMediaDto) || sanitizedMedia || null,
      replyToId: rpcData?.replyToId ? String(rpcData.replyToId) : rpcData?.reply_to_id ? String(rpcData.reply_to_id) : (dto.replyToId || null),
      clientNonce: rpcData?.clientNonce || rpcData?.client_nonce || nonce,
      editedAt: null,
      deletedAt: null,
      ...(attachmentDtos.length > 0 ? { attachments: attachmentDtos } : {}),
      reactions: [],
      createdAt: rpcData?.createdAt || rpcData?.created_at || new Date().toISOString(),
    };

    // 5. Phát sự kiện realtime (chỉ phát khi tin nhắn mới được tạo, không phát lại khi idempotent replay)
    if (!rpcData?.isDuplicate && !rpcData?.is_duplicate) {
      this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_CREATED, {
        conversationId: null,
        channelId,
        message: result,
      });
    }

    return result;
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
        'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
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
        'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .single();

    if (updateErr || !updated) {
      this.logger.error('Lỗi cập nhật tin nhắn:', updateErr);
      throw new InternalServerErrorException('Lỗi cập nhật tin nhắn.');
    }

    const rawUpdated = updated as RawMessageRow;
    const author = await this.getAuthorProfile(userId);
    const [attMap, extMediaMap] = await Promise.all([
      this.loadAttachmentsForMessages([rawUpdated.id]),
      this.loadExternalMediaForMessages([rawUpdated.id]),
    ]);
    const attachmentDtos = attMap.get(rawUpdated.id.toString()) || [];
    const extMedia = extMediaMap.get(rawUpdated.id.toString()) || null;

    const result: MessageResponseDto = {
      id: rawUpdated.id.toString(),
      channelId: rawUpdated.channel_id,
      conversationId: rawUpdated.conversation_id,
      authorId: rawUpdated.author_id,
      author,
      type: rawUpdated.type,
      content: rawUpdated.content,
      isForwarded: Boolean(rawUpdated.is_forwarded),
      externalMedia: extMedia,
      replyToId: rawUpdated.reply_to_id
        ? rawUpdated.reply_to_id.toString()
        : null,
      clientNonce: rawUpdated.client_nonce,
      editedAt: rawUpdated.edited_at,
      deletedAt: rawUpdated.deleted_at,
      ...(attachmentDtos.length > 0 ? { attachments: attachmentDtos } : {}),
      createdAt: rawUpdated.created_at,
    };

    this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_UPDATED, {
      conversationId: result.conversationId,
      channelId: result.channelId,
      message: result,
    });

    return result;
  }

  /**
   * Xoá tin nhắn (soft delete: set deleted_at = now()).
   */
  async deleteMessage(
    userId: string,
    messageId: string,
  ): Promise<{ id: string; deleted: boolean; conversationId: string | null; channelId: string | null }> {
    const { data: existing, error: findErr } = await this.supabase.client
      .from('messages')
      .select('id, conversation_id, channel_id, author_id, deleted_at')
      .eq('id', messageId)
      .maybeSingle();

    if (findErr || !existing) {
      throw new NotFoundException('Không tìm thấy tin nhắn.');
    }

    const raw = existing as RawMessageRow;
    if (raw.channel_id) {
      if (raw.author_id !== userId) {
        const perms = await this.serverPermissionsService.getChannelPermissions(userId, raw.channel_id);
        if ((perms & Permission.MANAGE_MESSAGES) === 0n) {
          throw new ForbiddenException('Bạn không có quyền xoá tin nhắn này.');
        }
      }
    } else {
      if (raw.author_id !== userId) {
        throw new ForbiddenException('Bạn chỉ có thể xoá tin nhắn của chính mình.');
      }
    }

    // 1. Tìm các attachments đính kèm (nếu có) để dọn dẹp Storage & DB metadata
    const { data: attRecords, error: attFindErr } = await this.supabase.client
      .from('attachments')
      .select('id, storage_path')
      .eq('message_id', messageId);

    if (attFindErr) {
      this.logger.error(
        `Lỗi truy vấn attachments khi xoá message ${messageId}:`,
        attFindErr,
      );
      throw new InternalServerErrorException(
        'Lỗi kiểm tra tệp đính kèm khi xoá tin nhắn.',
      );
    }

    if (attRecords && attRecords.length > 0) {
      const paths = attRecords.map((a) => a.storage_path);
      const { error: storageDelErr } = await this.supabase.client.storage
        .from('message-attachments')
        .remove(paths);

      if (storageDelErr) {
        this.logger.error(
          `Lỗi dọn dẹp storage objects của message ${messageId}:`,
          storageDelErr,
        );
        throw new InternalServerErrorException(
          'Lỗi dọn dẹp tập tin đính kèm khi xoá tin nhắn.',
        );
      }

      const { error: attDelErr } = await this.supabase.client
        .from('attachments')
        .delete()
        .eq('message_id', messageId);

      if (attDelErr) {
        this.logger.error(
          `Lỗi xoá metadata attachments của message ${messageId}:`,
          attDelErr,
        );
        throw new InternalServerErrorException(
          'Lỗi xoá dữ liệu tệp đính kèm trong cơ sở dữ liệu.',
        );
      }
    }

    // 2. Cập nhật soft delete trên bảng messages
    const now = new Date().toISOString();
    const { error: delErr } = await this.supabase.client
      .from('messages')
      .update({
        content: null,
        deleted_at: now,
      })
      .eq('id', messageId);

    if (delErr) {
      this.logger.error('Lỗi soft-delete tin nhắn:', delErr);
      throw new InternalServerErrorException('Lỗi xoá tin nhắn.');
    }

    // 3. Dọn dẹp toàn bộ reactions của tin nhắn sau khi soft-delete thành công
    try {
      const { error: reactCleanupErr } = await this.supabase.client
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId);

      if (reactCleanupErr) {
        this.logger.error(
          `Lỗi dọn dẹp reactions của message ${messageId} sau khi soft-delete:`,
          reactCleanupErr,
        );
      }
    } catch (cleanupEx) {
      this.logger.error(
        `Lỗi dọn dẹp reactions của message ${messageId} sau khi soft-delete:`,
        cleanupEx,
      );
    }

    // 4. Phát sự kiện realtime thông báo tin nhắn đã bị xoá
    this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_DELETED, {
      conversationId: raw.conversation_id,
      channelId: raw.channel_id ?? null,
      messageId,
    });

    return {
      id: messageId,
      deleted: true,
      conversationId: raw.conversation_id,
      channelId: raw.channel_id ?? null,
    };
  }

  /**
   * Tải lại signed URL mới cho attachment khi URL cũ hết hạn (401/403) trong cuộc trò chuyện.
   */
  async getAttachmentSignedUrl(
    userId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<{ signedUrl: string }> {
    const isMember = await this.conversationsService.verifyMembership(
      userId,
      conversationId,
    );
    if (!isMember) {
      throw new ForbiddenException(
        'Bạn không có quyền truy cập tệp trong cuộc trò chuyện này.',
      );
    }

    const { data, error } = await this.supabase.client
      .from('attachments')
      .select('id, storage_path, filename, message_id, messages!inner(conversation_id, deleted_at)')
      .eq('id', attachmentId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Không tìm thấy tệp đính kèm.');
    }

    const rawAtt = data as unknown as {
      id: string;
      storage_path: string;
      filename: string;
      message_id: string | number;
      messages:
        | { conversation_id: string; deleted_at: string | null }
        | { conversation_id: string; deleted_at: string | null }[];
    };

    const messageRecord = Array.isArray(rawAtt.messages)
      ? rawAtt.messages[0]
      : rawAtt.messages;

    if (
      !messageRecord ||
      messageRecord.conversation_id !== conversationId ||
      messageRecord.deleted_at !== null
    ) {
      throw new NotFoundException(
        'Tệp đính kèm không tồn tại hoặc tin nhắn đã bị xoá.',
      );
    }

    const { data: signed, error: signErr } = await this.supabase.client.storage
      .from('message-attachments')
      .createSignedUrl(rawAtt.storage_path, 3600, { download: rawAtt.filename });

    if (signErr || !signed?.signedUrl) {
      this.logger.error(
        `Lỗi tạo signed URL cho attachment ${attachmentId}:`,
        signErr,
      );
      throw new InternalServerErrorException(
        'Không thể tạo liên kết tải tệp đính kèm.',
      );
    }

    return { signedUrl: signed.signedUrl };
  }

  /**
   * Tải lại signed URL mới cho attachment khi URL cũ hết hạn (401/403) trong kênh máy chủ.
   */
  async getChannelAttachmentSignedUrl(
    userId: string,
    channelId: string,
    attachmentId: string,
  ): Promise<{ signedUrl: string }> {
    await this.serverPermissionsService.assertChannelView(userId, channelId);

    const { data, error } = await this.supabase.client
      .from('attachments')
      .select('id, storage_path, filename, message_id, messages!inner(channel_id, deleted_at)')
      .eq('id', attachmentId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Không tìm thấy tệp đính kèm.');
    }

    const rawAtt = data as unknown as {
      id: string;
      storage_path: string;
      filename: string;
      message_id: string | number;
      messages:
        | { channel_id: string | null; deleted_at: string | null }
        | { channel_id: string | null; deleted_at: string | null }[];
    };

    const messageRecord = Array.isArray(rawAtt.messages)
      ? rawAtt.messages[0]
      : rawAtt.messages;

    if (
      !messageRecord ||
      messageRecord.channel_id !== channelId ||
      messageRecord.deleted_at !== null
    ) {
      throw new NotFoundException('Tệp đính kèm không tồn tại hoặc tin nhắn đã bị xoá.');
    }

    const { data: signed, error: signErr } = await this.supabase.client.storage
      .from('message-attachments')
      .createSignedUrl(rawAtt.storage_path, 3600, { download: rawAtt.filename });

    if (signErr || !signed?.signedUrl) {
      this.logger.error(
        `Lỗi tạo signed URL cho channel attachment ${attachmentId}:`,
        signErr,
      );
      throw new InternalServerErrorException('Không thể tạo liên kết tải tệp đính kèm.');
    }

    return { signedUrl: signed.signedUrl };
  }

  /**
   * Đánh dấu đã đọc tin nhắn trong cuộc trò chuyện (nguyên tử qua RPC).
   */
  async markAsRead(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ success: boolean; updated?: boolean; lastReadMessageId?: string }> {
    if (!/^[1-9]\d*$/.test(messageId)) {
      throw new BadRequestException(
        'messageId phải là chuỗi số nguyên dương (bigint).',
      );
    }

    const { data, error } = await this.supabase.client.rpc(
      'mark_conversation_read',
      {
        p_user_id: userId,
        p_conversation_id: conversationId,
        p_message_id: messageId,
      },
    );

    if (error) {
      if (
        error.code === '42501' ||
        error.message?.includes('42501') ||
        error.message?.includes('participant')
      ) {
        throw new ForbiddenException(
          'Bạn không phải là thành viên của cuộc trò chuyện này.',
        );
      }

      if (
        error.code === '22023' ||
        error.message?.includes('22023') ||
        error.message?.includes('Message does not exist')
      ) {
        throw new BadRequestException(
          'Tin nhắn không tồn tại hoặc không thuộc cuộc trò chuyện này.',
        );
      }

      this.logger.error('Lỗi gọi RPC mark_conversation_read:', error);
      throw new InternalServerErrorException('Lỗi cập nhật trạng thái đọc.');
    }

    const row = Array.isArray(data) ? data[0] : data;
    const isUpdated = Boolean(row?.updated);
    const finalLastRead = String(row?.last_read_message_id ?? messageId);

    if (isUpdated) {
      this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_READ, {
        conversationId,
        userId,
        lastReadMessageId: finalLastRead,
      });
    }

    return {
      success: true,
      updated: isUpdated,
      lastReadMessageId: finalLastRead,
    };
  }

  /**
   * Thêm hoặc xóa reaction cho tin nhắn theo desired state (Idempotent).
   */
  async setReaction(
    userId: string,
    conversationId: string,
    messageId: string,
    dto: SetReactionDto,
  ): Promise<SetReactionResponseDto> {
    if (!isValidEmoji(dto.emoji)) {
      throw new BadRequestException('Biểu tượng cảm xúc (emoji) không hợp lệ.');
    }

    const emoji = dto.emoji.normalize('NFC').trim();

    const isMember = await this.conversationsService.verifyMembership(
      userId,
      conversationId,
    );
    if (!isMember) {
      throw new ForbiddenException(
        'Bạn không có quyền truy cập cuộc trò chuyện này.',
      );
    }

    const { data: messageData, error: msgErr } = await this.supabase.client
      .from('messages')
      .select('id, conversation_id, deleted_at')
      .eq('id', messageId)
      .maybeSingle();

    if (msgErr || !messageData) {
      throw new NotFoundException('Không tìm thấy tin nhắn.');
    }

    const msg = messageData as {
      id: string | number;
      conversation_id: string;
      deleted_at: string | null;
    };

    if (msg.conversation_id !== conversationId) {
      throw new BadRequestException('Tin nhắn không thuộc cuộc trò chuyện này.');
    }

    if (msg.deleted_at !== null) {
      throw new BadRequestException(
        'Không thể bày tỏ cảm xúc cho tin nhắn đã bị xoá.',
      );
    }

    let action: 'added' | 'removed' | null = null;

    if (dto.reacted) {
      const { data: inserted, error: insErr } = await this.supabase.client
        .from('message_reactions')
        .insert({
          message_id: messageId,
          user_id: userId,
          emoji,
        })
        .select('message_id');

      if (!insErr && inserted && inserted.length > 0) {
        action = 'added';
      }
    } else {
      const { data: deleted, error: delErr } = await this.supabase.client
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', userId)
        .eq('emoji', emoji)
        .select('message_id');

      if (!delErr && deleted && deleted.length > 0) {
        action = 'removed';
      }
    }

    // Tải canonical summary hiện tại của message này từ DB
    const { data: rawReactions } = await this.supabase.client
      .from('message_reactions')
      .select('emoji, user_id')
      .eq('message_id', messageId);

    const emojiMap = new Map<string, { count: number; reactedByMe: boolean }>();
    for (const r of (rawReactions ?? []) as { emoji: string; user_id: string }[]) {
      const stat = emojiMap.get(r.emoji);
      if (!stat) {
        emojiMap.set(r.emoji, {
          count: 1,
          reactedByMe: r.user_id === userId,
        });
      } else {
        stat.count += 1;
        if (r.user_id === userId) {
          stat.reactedByMe = true;
        }
      }
    }

    const reactions: ReactionSummaryDto[] = [];
    for (const [em, stat] of emojiMap.entries()) {
      reactions.push({
        emoji: em,
        count: stat.count,
        reactedByMe: stat.reactedByMe,
      });
    }

    // Chỉ emit event khi trạng thái thực sự thay đổi trong DB (không emit cho no-op/duplicate retry)
    if (action !== null) {
      this.eventEmitter.emit(CHAT_EVENTS.REACTION_UPDATED, {
        conversationId,
        messageId,
        actorUserId: userId,
        emoji,
        action,
        clientMutationId: dto.clientMutationId,
        reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
      });
    }

    return {
      messageId,
      conversationId,
      channelId: null,
      clientMutationId: dto.clientMutationId,
      reactions,
    };
  }

  /**
   * Thêm hoặc xóa reaction cho tin nhắn trong kênh máy chủ.
   */
  async setChannelReaction(
    userId: string,
    channelId: string,
    messageId: string,
    dto: SetReactionDto,
  ): Promise<SetReactionResponseDto> {
    if (!isValidEmoji(dto.emoji)) {
      throw new BadRequestException('Biểu tượng cảm xúc (emoji) không hợp lệ.');
    }

    const emoji = dto.emoji.normalize('NFC').trim();

    await this.serverPermissionsService.assertChannelView(userId, channelId);

    const { data: messageData, error: msgErr } = await this.supabase.client
      .from('messages')
      .select('id, channel_id, deleted_at')
      .eq('id', messageId)
      .maybeSingle();

    if (msgErr || !messageData) {
      throw new NotFoundException('Không tìm thấy tin nhắn.');
    }

    const msg = messageData as {
      id: string | number;
      channel_id: string;
      deleted_at: string | null;
    };

    if (msg.channel_id !== channelId) {
      throw new BadRequestException('Tin nhắn không thuộc kênh này.');
    }

    if (msg.deleted_at !== null) {
      throw new BadRequestException(
        'Không thể bày tỏ cảm xúc cho tin nhắn đã bị xoá.',
      );
    }

    let action: 'added' | 'removed' | null = null;

    if (dto.reacted) {
      const { data: inserted, error: insErr } = await this.supabase.client
        .from('message_reactions')
        .insert({
          message_id: messageId,
          user_id: userId,
          emoji,
        })
        .select('message_id');

      if (!insErr && inserted && inserted.length > 0) {
        action = 'added';
      }
    } else {
      const { data: deleted, error: delErr } = await this.supabase.client
        .from('message_reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('user_id', userId)
        .eq('emoji', emoji)
        .select('message_id');

      if (!delErr && deleted && deleted.length > 0) {
        action = 'removed';
      }
    }

    // Tải canonical summary hiện tại của message này từ DB
    const { data: rawReactions } = await this.supabase.client
      .from('message_reactions')
      .select('emoji, user_id')
      .eq('message_id', messageId);

    const emojiMap = new Map<string, { count: number; reactedByMe: boolean }>();
    for (const r of (rawReactions ?? []) as { emoji: string; user_id: string }[]) {
      const stat = emojiMap.get(r.emoji);
      if (!stat) {
        emojiMap.set(r.emoji, {
          count: 1,
          reactedByMe: r.user_id === userId,
        });
      } else {
        stat.count += 1;
        if (r.user_id === userId) {
          stat.reactedByMe = true;
        }
      }
    }

    const reactions: ReactionSummaryDto[] = [];
    for (const [em, stat] of emojiMap.entries()) {
      reactions.push({
        emoji: em,
        count: stat.count,
        reactedByMe: stat.reactedByMe,
      });
    }

    // Chỉ emit event khi trạng thái thực sự thay đổi trong DB
    if (action !== null) {
      this.eventEmitter.emit(CHAT_EVENTS.REACTION_UPDATED, {
        conversationId: null,
        channelId,
        messageId,
        actorUserId: userId,
        emoji,
        action,
        clientMutationId: dto.clientMutationId,
        reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
      });
    }

    return {
      messageId,
      conversationId: null,
      channelId,
      clientMutationId: dto.clientMutationId,
      reactions,
    };
  }

  /**
   * Đánh dấu đã đọc tin nhắn trong kênh máy chủ.
   */
  async markChannelAsRead(
    userId: string,
    channelId: string,
    messageId: string,
  ): Promise<{ success: boolean; updated?: boolean; lastReadMessageId?: string }> {
    if (!/^[1-9]\d*$/.test(messageId)) {
      throw new BadRequestException(
        'messageId phải là chuỗi số nguyên dương (bigint).',
      );
    }

    await this.serverPermissionsService.assertChannelView(userId, channelId);

    // Kiểm tra tin nhắn tồn tại và thuộc channel
    const { data: msg, error: msgErr } = await this.supabase.client
      .from('messages')
      .select('id, channel_id')
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .maybeSingle();

    if (msgErr || !msg) {
      throw new BadRequestException('Tin nhắn không tồn tại hoặc không thuộc kênh này.');
    }

    const { data: existingRead } = await this.supabase.client
      .from('read_states')
      .select('last_read_message_id')
      .eq('user_id', userId)
      .eq('channel_id', channelId)
      .maybeSingle();

    let shouldUpdate = true;
    if (existingRead && existingRead.last_read_message_id) {
      try {
        if (BigInt(existingRead.last_read_message_id) >= BigInt(messageId)) {
          shouldUpdate = false;
        }
      } catch {}
    }

    if (shouldUpdate) {
      const { error: upsertErr } = await this.supabase.client
        .from('read_states')
        .upsert(
          {
            user_id: userId,
            channel_id: channelId,
            conversation_id: null,
            last_read_message_id: messageId,
            last_read_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,channel_id' },
        );

      if (upsertErr) {
        this.logger.error('Lỗi cập nhật read_states channel:', upsertErr);
        throw new InternalServerErrorException('Lỗi cập nhật trạng thái đọc kênh.');
      }

      this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_READ, {
        channelId,
        conversationId: null,
        userId,
        readerId: userId,
        lastReadMessageId: messageId,
      });
    }

    return {
      success: true,
      updated: shouldUpdate,
      lastReadMessageId: messageId,
    };
  }

  /**
   * Chuyển tiếp tin nhắn sang cuộc trò chuyện hoặc kênh đích (Compensating Workflow & Idempotent).
   * Tạo bản sao độc lập (independent snapshot), copy storage objects, bảo toàn metadata file,
   * ghi nguyên tử qua PostgreSQL RPC/transaction, xử lý 23505 race condition, và phát dual realtime events.
   */
  async forwardMessage(
    userId: string,
    source: { sourceConversationId?: string; sourceChannelId?: string },
    messageId: string,
    dto: ForwardMessageDto,
  ): Promise<MessageResponseDto> {
    if (!/^[1-9]\d*$/.test(messageId)) {
      throw new BadRequestException('messageId phải là chuỗi số nguyên dương (bigint).');
    }

    if (!dto.clientNonce || typeof dto.clientNonce !== 'string') {
      throw new BadRequestException('clientNonce không được để trống.');
    }

    const hasTargetConv = !!dto.targetConversationId;
    const hasTargetChan = !!dto.targetChannelId;
    if ((!hasTargetConv && !hasTargetChan) || (hasTargetConv && hasTargetChan)) {
      throw new BadRequestException('Phải chỉ định chính xác một trong targetConversationId hoặc targetChannelId.');
    }

    // 1. Kiểm tra quyền truy cập ở nguồn và đích trước khi load message
    if (source.sourceConversationId && dto.targetConversationId) {
      const [isSourceMember, isTargetMember] = await Promise.all([
        this.conversationsService.verifyMembership(userId, source.sourceConversationId),
        this.conversationsService.verifyMembership(userId, dto.targetConversationId),
      ]);
      if (!isSourceMember) {
        throw new ForbiddenException('Bạn không phải là thành viên của cuộc trò chuyện nguồn.');
      }
      if (!isTargetMember) {
        throw new ForbiddenException('Bạn không phải là thành viên của cuộc trò chuyện đích.');
      }
    } else {
      if (source.sourceConversationId) {
        const isSourceMember = await this.conversationsService.verifyMembership(userId, source.sourceConversationId);
        if (!isSourceMember) {
          throw new ForbiddenException('Bạn không phải là thành viên của cuộc trò chuyện nguồn.');
        }
      } else if (source.sourceChannelId) {
        await this.serverPermissionsService.assertChannelView(userId, source.sourceChannelId);
      } else {
        throw new BadRequestException('Nguồn tin nhắn không hợp lệ.');
      }

      if (dto.targetConversationId) {
        const isTargetMember = await this.conversationsService.verifyMembership(userId, dto.targetConversationId);
        if (!isTargetMember) {
          throw new ForbiddenException('Bạn không phải là thành viên của cuộc trò chuyện đích.');
        }
      } else if (dto.targetChannelId) {
        await this.serverPermissionsService.assertChannelSend(userId, dto.targetChannelId);
      }
    }

    // 2. Load source message & kiểm tra soft delete
    let srcQuery = this.supabase.client
      .from('messages')
      .select('id, channel_id, conversation_id, content, deleted_at')
      .eq('id', messageId);

    if (source.sourceConversationId) {
      srcQuery = srcQuery.eq('conversation_id', source.sourceConversationId);
    } else {
      srcQuery = srcQuery.eq('channel_id', source.sourceChannelId);
    }

    const { data: sourceMsg, error: srcErr } = await srcQuery.maybeSingle();
    if (srcErr || !sourceMsg || sourceMsg.deleted_at) {
      throw new NotFoundException('Tin nhắn nguồn không tồn tại hoặc đã bị xóa.');
    }

    // 3. Load source attachments & externalMedia
    const [rawSrcAtts, rawSrcMedia] = await Promise.all([
      this.supabase.client
        .from('attachments')
        .select('id, storage_path, filename, mime_type, size_bytes, width, height')
        .eq('message_id', sourceMsg.id),
      this.loadExternalMediaForMessages([sourceMsg.id]),
    ]);

    if (rawSrcAtts.error) {
      this.logger.error('Lỗi tải metadata attachments nguồn:', rawSrcAtts.error);
      throw new InternalServerErrorException('Không thể đọc thông tin tệp đính kèm của tin nhắn nguồn.');
    }

    const sourceAttachments = (rawSrcAtts.data ?? []) as RawAttachmentRow[];
    const sourceExternalMedia = rawSrcMedia.get(sourceMsg.id.toString()) || null;
    const textContent = sourceMsg.content?.trim() || null;

    if (!textContent && sourceAttachments.length === 0 && !sourceExternalMedia) {
      throw new BadRequestException('Tin nhắn nguồn không có nội dung, tệp đính kèm hoặc ảnh GIF để chuyển tiếp.');
    }

    // Kiểm tra thêm quyền upload file nếu forward vào channel có attachments
    if (dto.targetChannelId && sourceAttachments.length > 0) {
      await this.serverPermissionsService.assertChannelAttach(userId, dto.targetChannelId);
    }

    // 5. Idempotency Check
    const { data: existing } = await this.supabase.client
      .from('messages')
      .select('id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at')
      .eq('author_id', userId)
      .eq('client_nonce', dto.clientNonce)
      .maybeSingle();

    if (existing) {
      const raw = existing as RawMessageRow;
      const matchConv = dto.targetConversationId && raw.conversation_id === dto.targetConversationId;
      const matchChan = dto.targetChannelId && raw.channel_id === dto.targetChannelId;
      if (!matchConv && !matchChan) {
        throw new ConflictException('Client nonce đã được sử dụng cho cuộc trò chuyện hoặc kênh khác.');
      }
      const author = await this.getAuthorProfile(userId);
      const [attMap, extMediaMap] = await Promise.all([
        this.loadAttachmentsForMessages([raw.id]),
        this.loadExternalMediaForMessages([raw.id]),
      ]);
      const existingAtts = attMap.get(raw.id.toString());
      const existingMedia = extMediaMap.get(raw.id.toString()) || null;

      return {
        id: raw.id.toString(),
        channelId: raw.channel_id,
        conversationId: raw.conversation_id,
        authorId: raw.author_id,
        author,
        type: raw.type,
        content: raw.deleted_at ? null : raw.content,
        isForwarded: true,
        externalMedia: existingMedia,
        replyToId: null,
        clientNonce: raw.client_nonce,
        editedAt: raw.edited_at,
        deletedAt: raw.deleted_at,
        ...(existingAtts && existingAtts.length > 0 ? { attachments: existingAtts } : {}),
        reactions: [],
        createdAt: raw.created_at,
      };
    }

    // 6. Copy Storage objects
    const correlationId = crypto.randomUUID();
    const copiedPaths: string[] = [];
    const newAttachmentsData: {
      storage_path: string;
      filename: string;
      mime_type: string;
      size_bytes: number | string;
      width: number | null;
      height: number | null;
    }[] = [];

    try {
      for (const att of sourceAttachments) {
        const newAttUuid = crypto.randomUUID();
        const ext = MIME_EXTENSION_MAP[att.mime_type] || (att.filename ? `.${att.filename.split('.').pop()}` : '');
        const targetStoragePath = dto.targetConversationId
          ? `conversations/${dto.targetConversationId}/${newAttUuid}${ext}`
          : `channels/${dto.targetChannelId}/${newAttUuid}${ext}`;

        const { error: copyErr } = await this.supabase.client.storage
          .from('message-attachments')
          .copy(att.storage_path, targetStoragePath);

        if (copyErr) {
          const { data: fileBlob, error: dlErr } = await this.supabase.client.storage
            .from('message-attachments')
            .download(att.storage_path);

          if (dlErr || !fileBlob) {
            throw new Error(`Copy/download storage object failed: ${copyErr.message || dlErr?.message}`);
          }

          const arrayBuffer = await fileBlob.arrayBuffer();
          const { error: upErr } = await this.supabase.client.storage
            .from('message-attachments')
            .upload(targetStoragePath, Buffer.from(arrayBuffer), {
              contentType: att.mime_type,
              upsert: false,
            });

          if (upErr) {
            throw new Error(`Upload fallback failed: ${upErr.message}`);
          }
        }

        copiedPaths.push(targetStoragePath);
        newAttachmentsData.push({
          storage_path: targetStoragePath,
          filename: att.filename,
          mime_type: att.mime_type,
          size_bytes: att.size_bytes,
          width: att.width,
          height: att.height,
        });
      }
    } catch (copyErr: any) {
      this.logger.error(`[Compensating Forward] Lỗi copy storage correlationId=${correlationId}: ${copyErr?.message}`);
      await this.cleanupStorageObjects(copiedPaths, correlationId);
      throw new InternalServerErrorException('Không thể sao chép tệp đính kèm khi chuyển tiếp.');
    }

    // 7. Atomic Write: Ghi message + attachments + externalMedia
    if (dto.targetConversationId) {
      const { data: rpcResult, error: rpcErr } = await this.supabase.client.rpc(
        'create_conversation_message',
        {
          p_conversation_id: dto.targetConversationId,
          p_author_id: userId,
          p_content: textContent,
          p_client_nonce: dto.clientNonce,
          p_reply_to_id: null,
          p_attachments: newAttachmentsData,
          p_is_forwarded: true,
          p_external_media: sourceExternalMedia,
        },
      );

      if (rpcErr) {
        if (
          rpcErr.code === '23505' ||
          rpcErr.message?.includes('23505') ||
          rpcErr.message?.includes('duplicate key')
        ) {
          await this.cleanupStorageObjects(copiedPaths, correlationId);
          const { data: canonical, error: canonErr } = await this.supabase.client
            .from('messages')
            .select(
              'id, channel_id, conversation_id, author_id, type, content, is_forwarded, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
            )
            .eq('author_id', userId)
            .eq('client_nonce', dto.clientNonce)
            .maybeSingle();

          if (canonErr || !canonical) {
            throw new InternalServerErrorException('Không thể truy vấn tin nhắn đã chuyển tiếp trùng nonce.');
          }

          const raw = canonical as RawMessageRow;
          if (raw.conversation_id !== dto.targetConversationId) {
            throw new ConflictException('Client nonce đã được sử dụng cho cuộc trò chuyện khác.');
          }
          if (raw.author_id !== userId) {
            throw new ForbiddenException('Client nonce không thuộc quyền sở hữu của bạn.');
          }

          const author = await this.getAuthorProfile(userId);
          const [attMap, extMediaMap] = await Promise.all([
            this.loadAttachmentsForMessages([raw.id]),
            this.loadExternalMediaForMessages([raw.id]),
          ]);
          const existingAtts = attMap.get(raw.id.toString());
          const existingMedia = extMediaMap.get(raw.id.toString()) || null;

          return {
            id: raw.id.toString(),
            channelId: raw.channel_id,
            conversationId: raw.conversation_id,
            authorId: raw.author_id,
            author,
            type: raw.type,
            content: raw.deleted_at ? null : raw.content,
            isForwarded: true,
            externalMedia: existingMedia,
            replyToId: null,
            clientNonce: raw.client_nonce,
            editedAt: raw.edited_at,
            deletedAt: raw.deleted_at,
            ...(existingAtts && existingAtts.length > 0 ? { attachments: existingAtts } : {}),
            reactions: [],
            createdAt: raw.created_at,
          };
        }

        await this.cleanupStorageObjects(copiedPaths, correlationId);
        if (
          rpcErr.code === '42883' ||
          rpcErr.message?.includes('PGRST202') ||
          rpcErr.message?.includes('does not exist')
        ) {
          throw new InternalServerErrorException(
            'Chức năng chuyển tiếp tin nhắn chưa sẵn sàng (migration database chưa được triển khai).',
          );
        }
        throw new InternalServerErrorException('Lỗi tạo tin nhắn chuyển tiếp vào cuộc trò chuyện.');
      }

      const msgId = rpcResult.id;
      const author = await this.getAuthorProfile(userId);
      const attMap = await this.loadAttachmentsForMessages([msgId]);
      const finalAttachments = attMap.get(msgId) || [];

      const responseDto: MessageResponseDto = {
        id: msgId,
        channelId: null,
        conversationId: dto.targetConversationId,
        authorId: userId,
        author,
        type: 'default',
        content: textContent,
        isForwarded: true,
        externalMedia: (rpcResult.externalMedia as GiphyMediaDto) || sourceExternalMedia || null,
        replyToId: null,
        clientNonce: dto.clientNonce,
        editedAt: null,
        deletedAt: null,
        ...(finalAttachments.length > 0 ? { attachments: finalAttachments } : {}),
        reactions: [],
        createdAt: rpcResult.createdAt || new Date().toISOString(),
      };

      this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_CREATED, {
        conversationId: dto.targetConversationId,
        channelId: null,
        message: responseDto,
      });

      return responseDto;
    } else {
      // Forward to channel
      const { data: rpcResult, error: rpcErr } = await this.supabase.client.rpc(
        'create_channel_message',
        {
          p_channel_id: dto.targetChannelId,
          p_author_id: userId,
          p_content: textContent,
          p_client_nonce: dto.clientNonce,
          p_reply_to_id: null,
          p_attachments: newAttachmentsData,
          p_is_forwarded: true,
          p_external_media: sourceExternalMedia,
        },
      );

      if (rpcErr) {
        await this.cleanupStorageObjects(copiedPaths, correlationId);
        if (rpcErr.code === '23505') {
          throw new ConflictException('Client nonce đã được sử dụng cho kênh hoặc cuộc trò chuyện khác.');
        }
        throw new InternalServerErrorException('Lỗi tạo tin nhắn chuyển tiếp vào kênh.');
      }

      const msgId = rpcResult.id;
      const author = await this.getAuthorProfile(userId);
      const attMap = await this.loadAttachmentsForMessages([msgId]);
      const finalAttachments = attMap.get(msgId) || [];

      const responseDto: MessageResponseDto = {
        id: msgId,
        channelId: dto.targetChannelId!,
        conversationId: null,
        authorId: userId,
        author,
        type: 'default',
        content: textContent,
        isForwarded: true,
        externalMedia: (rpcResult.externalMedia as GiphyMediaDto) || sourceExternalMedia || null,
        replyToId: null,
        clientNonce: dto.clientNonce,
        editedAt: null,
        deletedAt: null,
        ...(finalAttachments.length > 0 ? { attachments: finalAttachments } : {}),
        reactions: [],
        createdAt: rpcResult.createdAt,
      };

      this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_CREATED, {
        conversationId: null,
        channelId: dto.targetChannelId!,
        message: responseDto,
      });

      return responseDto;
    }
  }

  async forwardConversationMessage(
    userId: string,
    sourceConversationId: string,
    messageId: string,
    dto: ForwardMessageDto,
  ): Promise<MessageResponseDto> {
    return this.forwardMessage(userId, { sourceConversationId }, messageId, dto);
  }

  async forwardChannelMessage(
    userId: string,
    sourceChannelId: string,
    messageId: string,
    dto: ForwardMessageDto,
  ): Promise<MessageResponseDto> {
    return this.forwardMessage(userId, { sourceChannelId }, messageId, dto);
  }

  /**
   * Helper dọn dẹp Storage objects khi gặp sự cố bù trừ (Compensating Rollback).
   * Chỉ log safe correlationId và internal paths, không log thông tin nhạy cảm.
   */
  private async cleanupStorageObjects(
    paths: string[],
    correlationId: string,
  ): Promise<void> {
    if (!paths || paths.length === 0) return;
    try {
      const { error } = await this.supabase.client.storage
        .from('message-attachments')
        .remove(paths);

      if (error) {
        this.logger.error(
          `[Compensating Cleanup Storage Error] correlationId=${correlationId} paths=${paths.join(', ')}: ${error.message}`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[Compensating Cleanup Storage Exception] correlationId=${correlationId} paths=${paths.join(', ')}: ${err?.message}`,
      );
    }
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
