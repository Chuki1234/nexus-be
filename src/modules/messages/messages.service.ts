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
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';
import type { EditMessageDto } from './dto/edit-message.dto';
import type { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import type {
  AttachmentResponseDto,
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

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
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
  if (mimeType === 'text/plain') {
    return !buffer.includes(0x00);
  }
  return false;
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || 'attachment';
  const clean = base.replace(/[\x00-\x1f\x80-\x9f]/g, '').trim();
  return clean.slice(0, 255) || 'attachment';
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conversationsService: ConversationsService,
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

    // 2. Lấy attachments cho các tin nhắn chưa bị xoá (deleted_at === null)
    const activeRows = finalRows.filter((m) => !m.deleted_at);
    const activeMessageIds = activeRows.map((m) => m.id);
    const attachmentMap = await this.loadAttachmentsForMessages(activeMessageIds);

    const formattedMessages: MessageResponseDto[] = finalRows.map((m) => {
      const msgId = m.id.toString();
      const atts = m.deleted_at ? undefined : attachmentMap.get(msgId);
      return {
        id: msgId,
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
        ...(atts && atts.length > 0 ? { attachments: atts } : {}),
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
   * Gửi tin nhắn mới vào cuộc trò chuyện (hỗ trợ text và tối đa 5 file đính kèm).
   */
  async createConversationMessage(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
    files?: Express.Multer.File[],
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

    if (!text && uploadFiles.length === 0) {
      throw new BadRequestException(
        'Tin nhắn phải có nội dung văn bản hoặc ít nhất một file đính kèm.',
      );
    }

    if (uploadFiles.length > 5) {
      throw new BadRequestException(
        'Chỉ được đính kèm tối đa 5 file mỗi tin nhắn.',
      );
    }

    // Validate từng file & an toàn ảnh qua sharp
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const processedMetadata: {
      file: Express.Multer.File;
      width: number | null;
      height: number | null;
      ext: string;
    }[] = [];

    for (const f of uploadFiles) {
      if (f.size > MAX_FILE_SIZE) {
        throw new BadRequestException(
          `File "${f.originalname}" vượt quá dung lượng tối đa 10MB.`,
        );
      }

      if (!ALLOWED_MIME_TYPES.has(f.mimetype)) {
        throw new BadRequestException(
          `Định dạng file "${f.mimetype}" không được hỗ trợ.`,
        );
      }

      if (!checkMagicBytes(f.buffer, f.mimetype)) {
        throw new BadRequestException(
          `Tệp "${f.originalname}" có nội dung không khớp với định dạng ${f.mimetype}.`,
        );
      }

      let width: number | null = null;
      let height: number | null = null;

      if (f.mimetype.startsWith('image/')) {
        try {
          const image = sharp(f.buffer, {
            limitInputPixels: 25_000_000, // Giới hạn chống zip bomb / decompression bomb (~25 Megapixels)
            animated: f.mimetype === 'image/gif' || f.mimetype === 'image/webp',
          });
          const meta = await image.metadata();
          width = meta.width ?? null;
          height = meta.height ?? null;

          if (!width || !height) {
            throw new BadRequestException(
              `Không thể đọc kích thước của hình ảnh "${f.originalname}".`,
            );
          }

          if (width > 8192 || height > 8192) {
            throw new BadRequestException(
              `Kích thước hình ảnh "${f.originalname}" vượt quá giới hạn cho phép (tối đa 8192x8192px).`,
            );
          }

          if (meta.pages && meta.pages > 100) {
            throw new BadRequestException(
              `Ảnh động "${f.originalname}" có số lượng khung hình vượt quá giới hạn (tối đa 100 frames).`,
            );
          }
        } catch (err: unknown) {
          if (err instanceof BadRequestException) {
            throw err;
          }
          throw new BadRequestException(
            `Hình ảnh "${f.originalname}" bị lỗi, hỏng hoặc vượt giới hạn xử lý.`,
          );
        }
      }

      const ext = MIME_EXTENSION_MAP[f.mimetype] || '';
      processedMetadata.push({ file: f, width, height, ext });
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
        if (raw.conversation_id !== conversationId) {
          throw new ConflictException(
            'Client nonce đã được sử dụng cho cuộc trò chuyện khác.',
          );
        }
        const author = await this.getAuthorProfile(userId);
        const attMap = await this.loadAttachmentsForMessages([raw.id]);
        const existingAtts = attMap.get(raw.id.toString());

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
          ...(existingAtts && existingAtts.length > 0
            ? { attachments: existingAtts }
            : {}),
          createdAt: raw.created_at,
        };
      }
    }

    // 2. Validate replyToId nếu có
    if (dto.replyToId) {
      if (!/^[1-9]\d*$/.test(dto.replyToId)) {
        throw new BadRequestException(
          'replyToId phải là chuỗi số nguyên dương (bigint).',
        );
      }

      const { data: replyMsg, error: replyErr } = await this.supabase.client
        .from('messages')
        .select('id, conversation_id')
        .eq('id', dto.replyToId)
        .maybeSingle();

      if (replyErr || !replyMsg) {
        throw new BadRequestException('Tin nhắn được trả lời không tồn tại.');
      }

      if (replyMsg.conversation_id !== conversationId) {
        throw new BadRequestException(
          'Tin nhắn được trả lời không thuộc cuộc trò chuyện này.',
        );
      }
    }

    // 3. Upload file lên Storage (Message Attachments Bucket)
    const uploadedPaths: string[] = [];
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
      }
    } catch (uploadErr) {
      // Dọn dẹp các file đã tải lên trước đó nếu có lỗi
      if (uploadedPaths.length > 0) {
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
      }
      throw new InternalServerErrorException(
        'Lỗi lưu trữ tập tin đính kèm. Vui lòng thử lại.',
      );
    }

    // 4. Chèn tin nhắn mới vào bảng messages
    const { data: newMsg, error: insertErr } = await this.supabase.client
      .from('messages')
      .insert({
        conversation_id: conversationId,
        author_id: userId,
        content: text,
        client_nonce: dto.clientNonce ?? null,
        reply_to_id: dto.replyToId ?? null,
      })
      .select(
        'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
      )
      .single();

    if (insertErr || !newMsg) {
      // Xoá các file vừa upload nếu chèn tin nhắn thất bại để tránh orphan files
      if (uploadedPaths.length > 0) {
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
      }

      if (
        insertErr &&
        (insertErr.code === '23505' || insertErr.message?.includes('23505')) &&
        dto.clientNonce
      ) {
        const { data: duplicate } = await this.supabase.client
          .from('messages')
          .select(
            'id, channel_id, conversation_id, author_id, type, content, reply_to_id, client_nonce, edited_at, deleted_at, created_at',
          )
          .eq('author_id', userId)
          .eq('client_nonce', dto.clientNonce)
          .maybeSingle();

        if (duplicate) {
          const rawDup = duplicate as RawMessageRow;
          if (rawDup.conversation_id !== conversationId) {
            throw new ConflictException(
              'Client nonce đã được sử dụng cho cuộc trò chuyện khác.',
            );
          }
          const author = await this.getAuthorProfile(userId);
          const attMap = await this.loadAttachmentsForMessages([rawDup.id]);
          const dupAtts = attMap.get(rawDup.id.toString());

          return {
            id: rawDup.id.toString(),
            channelId: rawDup.channel_id,
            conversationId: rawDup.conversation_id,
            authorId: rawDup.author_id,
            author,
            type: rawDup.type,
            content: rawDup.deleted_at ? null : rawDup.content,
            replyToId: rawDup.reply_to_id
              ? rawDup.reply_to_id.toString()
              : null,
            clientNonce: rawDup.client_nonce,
            editedAt: rawDup.edited_at,
            deletedAt: rawDup.deleted_at,
            ...(dupAtts && dupAtts.length > 0 ? { attachments: dupAtts } : {}),
            createdAt: rawDup.created_at,
          };
        }
      }

      this.logger.error('Lỗi chèn tin nhắn:', insertErr);
      throw new InternalServerErrorException('Không thể gửi tin nhắn.');
    }

    const raw = newMsg as RawMessageRow;

    // 5. Chèn attachments vào bảng public.attachments
    if (processedMetadata.length > 0) {
      const rowsToInsert = processedMetadata.map((item, idx) => ({
        message_id: raw.id,
        storage_path: uploadedPaths[idx],
        filename: sanitizeFilename(item.file.originalname),
        mime_type: item.file.mimetype,
        size_bytes: item.file.size,
        width: item.width,
        height: item.height,
      }));

      const { data: createdAttachments, error: attInsertErr } =
        await this.supabase.client
          .from('attachments')
          .insert(rowsToInsert)
          .select(
            'id, message_id, storage_path, filename, mime_type, size_bytes, width, height, created_at',
          );

      if (attInsertErr || !createdAttachments) {
        this.logger.error('Lỗi lưu bản ghi attachments:', attInsertErr);
        // Rollback: xoá tin nhắn và xoá storage files
        await this.supabase.client.from('messages').delete().eq('id', raw.id);
        await this.supabase.client.storage
          .from('message-attachments')
          .remove(uploadedPaths);
        throw new InternalServerErrorException(
          'Lỗi lưu thông tin tập tin đính kèm.',
        );
      }
    }

    // Tải attachments kèm signed URLs qua helper chung
    const attMap = await this.loadAttachmentsForMessages([raw.id]);
    const attachmentDtos = attMap.get(raw.id.toString()) || [];

    const author = await this.getAuthorProfile(userId);

    const result: MessageResponseDto = {
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
      ...(attachmentDtos.length > 0 ? { attachments: attachmentDtos } : {}),
      createdAt: raw.created_at,
    };

    this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_CREATED, {
      conversationId,
      channelId: null,
      message: result,
    });

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

    const result: MessageResponseDto = {
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
          'Lỗi xoá thông tin tệp đính kèm.',
        );
      }
    }

    // 2. Soft-delete tin nhắn
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

    this.eventEmitter.emit(CHAT_EVENTS.MESSAGE_DELETED, {
      conversationId: raw.conversation_id,
      channelId: null,
      messageId,
    });

    return {
      id: messageId,
      deleted: true,
      conversationId: raw.conversation_id,
    };
  }

  /**
   * Tải lại signed URL mới cho attachment khi URL cũ hết hạn (401/403).
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
      .select('id, storage_path, message_id, messages!inner(conversation_id, deleted_at)')
      .eq('id', attachmentId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Không tìm thấy tệp đính kèm.');
    }

    const rawAtt = data as unknown as {
      id: string;
      storage_path: string;
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
      .createSignedUrl(rawAtt.storage_path, 3600);

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
