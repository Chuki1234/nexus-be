import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import { SupabaseService } from '../../infra/supabase/supabase.service';
import { ConversationsService } from '../conversations/conversations.service';
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';
import {
  formatContentDisposition,
  isValidEmoji,
  MessagesService,
  normalizeFilename,
} from './messages.service';

function defaultTableHandler(table: string) {
  if (table === 'attachments') {
    return {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ data: [], error: null }),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({ data: [], error: null }),
      }),
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    };
  }
  if (table === 'message_reactions') {
    return {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ data: [], error: null }),
      eq: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({ data: [], error: null }),
      }),
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({ data: [], error: null }),
      }),
    };
  }
  return {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
}

describe('MessagesService', () => {
  let service: MessagesService;
  let mockSupabase: {
    client: { from: jest.Mock; rpc: jest.Mock; storage: { from: jest.Mock } };
  };
  let mockConversationsService: { verifyMembership: jest.Mock };
  let mockEventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    mockSupabase = {
      client: {
        from: jest.fn().mockImplementation((table: string) => defaultTableHandler(table)),
        rpc: jest.fn(),
        storage: {
          from: jest.fn().mockReturnValue({
            upload: jest.fn().mockResolvedValue({ error: null }),
            remove: jest.fn().mockResolvedValue({ error: null }),
            createSignedUrls: jest.fn().mockImplementation((paths: string[]) => {
              return Promise.resolve({
                data: (paths || []).map((p) => ({
                  path: p,
                  signedUrl: `https://storage.supabase.co/signed/${p.split('/').pop()}`,
                })),
                error: null,
              });
            }),
            getPublicUrl: jest.fn().mockReturnValue({
              data: { publicUrl: 'https://storage.supabase.co/public/test.png' },
            }),
          }),
        },
      },
    };

    mockConversationsService = {
      verifyMembership: jest.fn().mockResolvedValue(true),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: ConversationsService, useValue: mockConversationsService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<MessagesService>(MessagesService);
  });

  describe('getConversationMessages', () => {
    it('chặn nếu không phải thành viên conversation (403)', async () => {
      mockConversationsService.verifyMembership.mockResolvedValueOnce(false);

      await expect(
        service.getConversationMessages('user-1', 'conv-1', {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('tải danh sách tin nhắn và trả về đúng định dạng kể cả bigint lớn hơn MAX_SAFE_INTEGER', async () => {
      const hugeBigintId = '9007199254740999999';
      const mockRawMessages = [
        {
          id: hugeBigintId,
          channel_id: null,
          conversation_id: 'conv-1',
          author_id: 'user-1',
          type: 'default',
          content: 'Hello Huge BigInt',
          reply_to_id: null,
          client_nonce: 'nonce-1',
          edited_at: null,
          deleted_at: null,
          created_at: '2026-08-22T10:00:00Z',
        },
      ];

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue({
              data: mockRawMessages,
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'user-1',
                  username: 'user1',
                  display_name: 'User One',
                  avatar_url: null,
                },
              ],
              error: null,
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'att-99',
                  message_id: hugeBigintId,
                  storage_path: 'conversations/conv-1/test.png',
                  filename: 'test.png',
                  mime_type: 'image/png',
                  size_bytes: 1024,
                  width: 100,
                  height: 100,
                  created_at: '2026-08-22T10:00:00Z',
                },
              ],
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.getConversationMessages('user-1', 'conv-1', {
        limit: 50,
      });
      expect(res.messages.length).toBe(1);
      expect(res.messages[0].id).toBe(hugeBigintId);
      expect(res.messages[0].content).toBe('Hello Huge BigInt');
      expect(res.messages[0].author?.displayName).toBe('User One');
      expect(res.messages[0].attachments?.length).toBe(1);
      expect(res.messages[0].attachments?.[0].signedUrl).toBe(
        'https://storage.supabase.co/signed/test.png',
      );
      expect(res.hasMore).toBe(false);
    });
  });

  describe('createConversationMessage', () => {
    it('chặn tin nhắn rỗng (400)', async () => {
      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('chặn reply nếu tin nhắn gốc không tồn tại (400)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      });

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: 'Reply nè',
          replyToId: '9999',
        }),
      ).rejects.toThrow('Tin nhắn được trả lời không tồn tại.');
    });

    it('chặn reply nếu tin nhắn gốc thuộc conversation khác (400)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: '888', conversation_id: 'conv-OTHER' },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: 'Reply chéo conversation',
          replyToId: '888',
        }),
      ).rejects.toThrow('Tin nhắn được trả lời không thuộc cuộc trò chuyện này.');
    });

    it('trả về tin nhắn đã có nếu clientNonce trùng trong cùng conversation (idempotency)', async () => {
      const mockExisting = {
        id: '9007199254740999999',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Tin đã gửi',
        reply_to_id: null,
        client_nonce: 'nonce-123',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T09:00:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: mockExisting,
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'user1',
                display_name: 'User One',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage('user-1', 'conv-1', {
        content: 'Tin đã gửi',
        clientNonce: 'nonce-123',
      });
      expect(res.id).toBe('9007199254740999999');
      expect(res.content).toBe('Tin đã gửi');
    });

    it('ném lỗi Conflict (409) nếu clientNonce đã dùng ở conversation khác', async () => {
      const mockExistingOtherConv = {
        id: '88',
        channel_id: null,
        conversation_id: 'conv-OTHER',
        author_id: 'user-1',
        type: 'default',
        content: 'Tin ở conv khác',
        reply_to_id: null,
        client_nonce: 'nonce-duplicate',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T09:00:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: mockExistingOtherConv,
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: 'Tin nhắn gửi lại',
          clientNonce: 'nonce-duplicate',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('xử lý race condition 23505 trả về tin nhắn thành công không ném 500', async () => {
      const mockDupMessage = {
        id: '9007199254740999999',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Race condition text',
        reply_to_id: null,
        client_nonce: 'nonce-race',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:00:00Z',
      };

      let queryCallCount = 0;
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockImplementation(() => {
              queryCallCount++;
              if (queryCallCount === 1) {
                return Promise.resolve({ data: null, error: null });
              }
              return Promise.resolve({ data: mockDupMessage, error: null });
            }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                }),
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'user-1', username: 'user1', display_name: 'User One', avatar_url: null },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage('user-1', 'conv-1', {
        content: 'Race condition text',
        clientNonce: 'nonce-race',
      });

      expect(res.id).toBe('9007199254740999999');
      expect(res.content).toBe('Race condition text');
    });

    it('chèn tin nhắn mới có replyToId dạng string bigint và emit domain event', async () => {
      const mockCreated = {
        id: '9007199254740999999',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Tin nhắn mới',
        reply_to_id: '9007199254740999888',
        client_nonce: 'nonce-456',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:05:00Z',
      };

      const insertMock = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({
            data: mockCreated,
            error: null,
          }),
        }),
      });

      let selectCount = 0;
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockImplementation(() => {
              selectCount++;
              if (selectCount === 1) {
                // Pre-check clientNonce: không có tin nhắn trùng
                return Promise.resolve({ data: null, error: null });
              }
              // Kiểm tra tin nhắn reply tồn tại
              return Promise.resolve({
                data: { id: '9007199254740999888', conversation_id: 'conv-1' },
                error: null,
              });
            }),
            insert: insertMock,
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'user1',
                display_name: 'User One',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage('user-1', 'conv-1', {
        content: 'Tin nhắn mới',
        clientNonce: 'nonce-456',
        replyToId: '9007199254740999888',
      });

      expect(res.id).toBe('9007199254740999999');
      expect(res.replyToId).toBe('9007199254740999888');
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          reply_to_id: '9007199254740999888',
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_CREATED,
        expect.objectContaining({
          conversationId: 'conv-1',
          message: expect.objectContaining({ id: '9007199254740999999' }),
        }),
      );
    });

    it('gửi tin nhắn kèm file hợp lệ thành công và tạo signed URL', async () => {
      // Buffer hợp lệ của ảnh PNG (magic bytes 89 50 4E 47 0D 0A 1A 0A)
      const validPngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const mockFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'screenshot.png',
        encoding: '7bit',
        mimetype: 'image/png',
        size: validPngBuffer.length,
        buffer: validPngBuffer,
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      const mockCreated = {
        id: '12345',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Check ảnh này nhé',
        reply_to_id: null,
        client_nonce: null,
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:10:00Z',
      };

      const mockCreatedAttachment = {
        id: 'att-1',
        message_id: '12345',
        storage_path: 'conversations/conv-1/att-1.png',
        filename: 'screenshot.png',
        mime_type: 'image/png',
        size_bytes: validPngBuffer.length,
        width: 1,
        height: 1,
        created_at: '2026-08-22T10:10:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: mockCreated,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [mockCreatedAttachment],
              error: null,
            }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue({
                data: [mockCreatedAttachment],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'user1',
                display_name: 'User One',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage(
        'user-1',
        'conv-1',
        { content: 'Check ảnh này nhé' },
        [mockFile],
      );

      expect(res.id).toBe('12345');
      expect(res.attachments).toBeDefined();
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].filename).toBe('screenshot.png');
      expect(res.attachments?.[0].signedUrl).toBeDefined();
    });

    it('cho phép gửi tin nhắn chỉ có file (không có text content)', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 sample pdf file content');
      const mockPdfFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'document.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: pdfBuffer.length,
        buffer: pdfBuffer,
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      const mockCreated = {
        id: '12346',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: null,
        reply_to_id: null,
        client_nonce: null,
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:11:00Z',
      };

      const mockCreatedAttachment = {
        id: 'att-2',
        message_id: '12346',
        storage_path: 'conversations/conv-1/att-2.pdf',
        filename: 'document.pdf',
        mime_type: 'application/pdf',
        size_bytes: pdfBuffer.length,
        width: null,
        height: null,
        created_at: '2026-08-22T10:11:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: mockCreated,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [mockCreatedAttachment],
              error: null,
            }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue({
                data: [mockCreatedAttachment],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'user1',
                display_name: 'User One',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage(
        'user-1',
        'conv-1',
        {},
        [mockPdfFile],
      );

      expect(res.id).toBe('12346');
      expect(res.content).toBeNull();
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].filename).toBe('document.pdf');
    });

    it('từ chối gửi nếu cả content và files đều rỗng (400)', async () => {
      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('từ chối gửi nếu có quá 5 files đính kèm (400)', async () => {
      const dummyFile = (name: string): Express.Multer.File => ({
        fieldname: 'files',
        originalname: name,
        encoding: '7bit',
        mimetype: 'text/plain',
        size: 10,
        buffer: Buffer.from('hello text'),
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      });

      const sixFiles = [
        dummyFile('1.txt'),
        dummyFile('2.txt'),
        dummyFile('3.txt'),
        dummyFile('4.txt'),
        dummyFile('5.txt'),
        dummyFile('6.txt'),
      ];

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, sixFiles),
      ).rejects.toThrow('Chỉ được đính kèm tối đa 5 file mỗi tin nhắn.');
    });

    it('từ chối file có dung lượng vượt quá 10MB (400)', async () => {
      const oversizedFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'big_video.zip',
        encoding: '7bit',
        mimetype: 'application/zip',
        size: 11 * 1024 * 1024,
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [
          oversizedFile,
        ]),
      ).rejects.toThrow('vượt quá dung lượng tối đa 10MB.');
    });

    it('từ chối file có MIME type không trong danh sách cho phép (400)', async () => {
      const invalidMimeFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'script.exe',
        encoding: '7bit',
        mimetype: 'application/x-msdownload',
        size: 100,
        buffer: Buffer.from('MZ...'),
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [
          invalidMimeFile,
        ]),
      ).rejects.toThrow('không được hỗ trợ.');
    });

    it('từ chối file giả mạo extension với magic bytes không khớp (400)', async () => {
      const fakePngFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'virus.png',
        encoding: '7bit',
        mimetype: 'image/png',
        size: 100,
        buffer: Buffer.from('this is plain text pretending to be png'),
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [fakePngFile]),
      ).rejects.toThrow('có nội dung không khớp với định dạng');
    });

    it('tự động rollback và xóa file Storage nếu chèn database attachments thất bại', async () => {
      const validPngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      const mockFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'valid.png',
        encoding: '7bit',
        mimetype: 'image/png',
        size: validPngBuffer.length,
        buffer: validPngBuffer,
        stream: null as any,
        destination: '',
        filename: '',
        path: '',
      };

      const mockCreatedMsg = {
        id: '99999',
        conversation_id: 'conv-1',
      };

      const deleteMessageMock = jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: mockCreatedMsg,
                  error: null,
                }),
              }),
            }),
            delete: deleteMessageMock,
          };
        }
        if (table === 'attachments') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue({
                data: null,
                error: { message: 'Database constraint error' },
              }),
            }),
          };
        }
        return {};
      });

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [mockFile]),
      ).rejects.toThrow('Lỗi lưu thông tin tập tin đính kèm.');

      // Kiểm tra xem message đã được rollback xóa chưa
      expect(deleteMessageMock).toHaveBeenCalled();
    });

    it('từ chối membership trước khi upload tệp (không gọi storage.upload)', async () => {
      mockConversationsService.verifyMembership.mockResolvedValueOnce(false);
      const mockFile = {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
        originalname: 'test.png',
        mimetype: 'image/png',
        size: 1024,
      } as Express.Multer.File;

      await expect(
        service.createConversationMessage('intruder', 'conv-1', {}, [mockFile]),
      ).rejects.toThrow(ForbiddenException);

      expect(mockSupabase.client.storage.from).not.toHaveBeenCalled();
    });

    it('idempotency: duplicate clientNonce trả về đầy đủ attachments đã lưu trước đó', async () => {
      const existingMsg = {
        id: '1001',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Existing with att',
        reply_to_id: null,
        client_nonce: 'nonce-dup',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:00:00Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: existingMsg,
              error: null,
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'user-1', username: 'u1', display_name: 'U1' },
              error: null,
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'att-existing',
                  message_id: '1001',
                  storage_path: 'conversations/conv-1/dup.png',
                  filename: 'dup.png',
                  mime_type: 'image/png',
                  size_bytes: 2048,
                  width: 200,
                  height: 200,
                  created_at: '2026-08-22T10:00:00Z',
                },
              ],
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage(
        'user-1',
        'conv-1',
        { content: 'Existing with att', clientNonce: 'nonce-dup' },
        undefined,
      );

      expect(res.id).toBe('1001');
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].signedUrl).toBe(
        'https://storage.supabase.co/signed/dup.png',
      );
    });

    it('race 23505: duplicate insert trả về tin nhắn và dọn dẹp file vừa upload', async () => {
      const validPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const mockFile = {
        buffer: Buffer.from(validPngBase64, 'base64'),
        originalname: 'race.png',
        mimetype: 'image/png',
        size: 1024,
      } as Express.Multer.File;

      const dupMsg = {
        id: '1002',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Race msg',
        reply_to_id: null,
        client_nonce: 'nonce-race',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-22T10:00:00Z',
      };

      const removeStorageMock = jest.fn().mockResolvedValue({ error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        upload: jest.fn().mockResolvedValue({ error: null }),
        remove: removeStorageMock,
        createSignedUrls: jest.fn().mockImplementation((paths: string[]) => {
          return Promise.resolve({
            data: (paths || []).map((p) => ({
              path: p,
              signedUrl: `https://storage.supabase.co/signed/${p.split('/').pop()}`,
            })),
            error: null,
          });
        }),
      });

      let insertCallCount = 0;
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              // Lần 1: check trước insert không thấy; Lần 2: sau 23505 thấy dupMsg
              data: insertCallCount === 0 ? null : dupMsg,
              error: null,
            }),
            insert: jest.fn().mockImplementation(() => {
              insertCallCount++;
              return {
                select: jest.fn().mockReturnThis(),
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                }),
              };
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'user-1', username: 'u1', display_name: 'U1' },
              error: null,
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.createConversationMessage(
        'user-1',
        'conv-1',
        { content: 'Race msg', clientNonce: 'nonce-race' },
        [mockFile],
      );

      expect(res.id).toBe('1002');
      expect(removeStorageMock).toHaveBeenCalled();
    });

    it('từ chối ảnh hỏng không đọc được metadata qua sharp (400)', async () => {
      // Magic bytes PNG nhưng thân file hỏng
      const corruptedFile = {
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        originalname: 'corrupt.png',
        mimetype: 'image/png',
        size: 1024,
      } as Express.Multer.File;

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [corruptedFile]),
      ).rejects.toThrow('bị lỗi, hỏng hoặc không thể xử lý.');
    });

    it('chấp nhận file GIF hợp lệ và lưu đúng kích thước frameHeight (thay vì tổng chiều cao các frame)', async () => {
      // Tạo file GIF hợp lệ qua sharp (400x300px)
      const validGifBuffer = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 4,
          background: { r: 0, g: 255, b: 128, alpha: 1 },
        },
      })
        .gif()
        .toBuffer();

      let insertedAttachmentRows: any[] = [];
      mockSupabase.client.from = jest.fn().mockImplementation((table: string) => {
        if (table === 'conversation_participants') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { conversation_id: 'conv-1', user_id: 'user-1' },
              error: null,
            }),
          };
        }
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: 2001,
                    conversation_id: 'conv-1',
                    author_id: 'user-1',
                    content: 'Animated GIF msg',
                    type: 'default',
                    reply_to_id: null,
                    client_nonce: 'nonce-gif',
                    edited_at: null,
                    deleted_at: null,
                    created_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'att-gif-1',
                  message_id: 2001,
                  storage_path: 'conversations/conv-1/sample.gif',
                  filename: 'animated_sticker.gif',
                  mime_type: 'image/gif',
                  size_bytes: validGifBuffer.length,
                  width: 400,
                  height: 300,
                  created_at: new Date().toISOString(),
                },
              ],
              error: null,
            }),
            insert: jest.fn().mockImplementation((rows: any[]) => {
              insertedAttachmentRows = rows;
              return {
                select: jest.fn().mockResolvedValue({
                  data: rows.map((r, i) => ({ ...r, id: `att-${i}` })),
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'user-1', username: 'u1', display_name: 'U1' },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const gifFile = {
        buffer: validGifBuffer,
        originalname: 'animated_sticker.gif',
        mimetype: 'image/gif',
        size: validGifBuffer.length,
      } as Express.Multer.File;

      const res = await service.createConversationMessage(
        'user-1',
        'conv-1',
        { content: 'Animated GIF msg' },
        [gifFile],
      );

      expect(res.id).toBe('2001');
      expect(insertedAttachmentRows.length).toBe(1);
      expect(insertedAttachmentRows[0].width).toBe(400);
      expect(insertedAttachmentRows[0].height).toBe(300);
      expect(insertedAttachmentRows[0].filename).toBe('animated_sticker.gif');
    });

    it('từ chối ảnh có frame dimension vượt quá 4096px với thông báo chính xác', async () => {
      // Giả lập metadata frame > 4096
      const hugeFrameBuffer = await sharp({
        create: {
          width: 5000,
          height: 100,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .jpeg()
        .toBuffer();

      const hugeFile = {
        buffer: hugeFrameBuffer,
        originalname: 'huge_panorama.jpg',
        mimetype: 'image/jpeg',
        size: hugeFrameBuffer.length,
      } as Express.Multer.File;

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [hugeFile]),
      ).rejects.toThrow('vượt quá giới hạn tối đa 4096x4096px');
    });
  });

  describe('normalizeFilename & formatContentDisposition', () => {
    it('giữ nguyên tên file ASCII chuẩn', () => {
      expect(normalizeFilename('document.pdf')).toBe('document.pdf');
      expect(normalizeFilename('archive_2026.zip')).toBe('archive_2026.zip');
    });

    it('bảo toàn nguyên vẹn tên file tiếng Việt có dấu đã đúng chuẩn UTF-8', () => {
      const name = 'Báo cáo thực tập kỳ 2 (Bản chuẩn).pdf';
      expect(normalizeFilename(name)).toBe(name);
    });

    it('giải mã chính xác tên file tiếng Việt bị mojibake Latin-1 thành UTF-8', () => {
      // 'Báo cáo.pdf' bị Busboy parse nhầm thành Latin-1: 'BÃ¡o cÃ¡o.pdf'
      const mojibake = Buffer.from('Báo cáo.pdf', 'utf8').toString('latin1');
      expect(normalizeFilename(mojibake)).toBe('Báo cáo.pdf');
    });

    it('bảo toàn Emoji trong tên file', () => {
      const emojiName = '📊 data_report.xlsx';
      expect(normalizeFilename(emojiName)).toBe('📊 data_report.xlsx');
    });

    it('idempotent: gọi nhiều lần không tiếp tục biến đổi chuỗi', () => {
      const original = 'Báo cáo tài chính 2026.pdf';
      const step1 = normalizeFilename(original);
      const step2 = normalizeFilename(step1);
      const step3 = normalizeFilename(step2);

      expect(step1).toBe(original);
      expect(step2).toBe(original);
      expect(step3).toBe(original);
    });

    it('loại bỏ path traversal và control characters nguy hiểm', () => {
      expect(normalizeFilename('../../secret/passwords.txt')).toBe('passwords.txt');
      expect(normalizeFilename('file\x00\x1f\x7fname.png')).toBe('filename.png');
    });

    it('formatContentDisposition tuân thủ RFC 5987 / RFC 6266 và chống CRLF injection', () => {
      const result = formatContentDisposition('Báo cáo kỳ 2.pdf\r\nInjected-Header: evil');
      expect(result).not.toContain('\r');
      expect(result).not.toContain('\n');
      expect(result).toContain('filename="B_o c_o k_ 2.pdf__Injected-Header: evil"');
      expect(result).toContain("filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20k%E1%BB%B3%202.pdf__Injected-Header%3A%20evil");
    });
  });

  describe('markAsRead', () => {
    it('chặn nếu messageId không phải số bigint dương (400)', async () => {
      await expect(
        service.markAsRead('user-1', 'conv-1', 'invalid-id'),
      ).rejects.toThrow(BadRequestException);
    });

    it('báo lỗi 403 Forbidden nếu RPC trả lỗi 42501 (không phải participant)', async () => {
      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: null,
        error: { code: '42501', message: 'User is not a participant of this conversation' },
      });

      await expect(
        service.markAsRead('user-intruder', 'conv-1', '9999'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('báo lỗi 400 BadRequest nếu RPC trả lỗi 22023 (tin nhắn không tồn tại hoặc sai conv)', async () => {
      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: null,
        error: { code: '22023', message: 'Message does not exist in this conversation' },
      });

      await expect(
        service.markAsRead('user-1', 'conv-1', '100'),
      ).rejects.toThrow(BadRequestException);
    });

    it('không emit CHAT_EVENTS.MESSAGE_READ nếu RPC trả updated=false (stale hoặc lùi read-state)', async () => {
      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: [{ success: true, updated: false, last_read_message_id: '9007199254740999200' }],
        error: null,
      });

      const res = await service.markAsRead('user-1', 'conv-1', '9007199254740999100');
      expect(res.success).toBe(true);
      expect(res.updated).toBe(false);
      expect(res.lastReadMessageId).toBe('9007199254740999200');
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('emit CHAT_EVENTS.MESSAGE_READ và trả updated=true khi tiến lên thành công với bigint lớn', async () => {
      const hugeId = '9007199254740999999';
      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: [{ success: true, updated: true, last_read_message_id: hugeId }],
        error: null,
      });

      const res = await service.markAsRead('user-1', 'conv-1', hugeId);
      expect(res.success).toBe(true);
      expect(res.updated).toBe(true);
      expect(res.lastReadMessageId).toBe(hugeId);
      expect(mockSupabase.client.rpc).toHaveBeenCalledWith(
        'mark_conversation_read',
        {
          p_user_id: 'user-1',
          p_conversation_id: 'conv-1',
          p_message_id: hugeId,
        },
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_READ,
        {
          conversationId: 'conv-1',
          userId: 'user-1',
          lastReadMessageId: hugeId,
        },
      );
    });
  });

  describe('editMessage', () => {
    it('chặn chỉnh sửa tin nhắn của người khác (403)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                author_id: 'user-other',
                deleted_at: null,
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(
        service.editMessage('user-1', '101', { content: 'Sửa nè' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('chặn chỉnh sửa tin nhắn đã bị soft delete (400)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                author_id: 'user-1',
                deleted_at: '2026-08-22T09:00:00Z',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(
        service.editMessage('user-1', '101', { content: 'Sửa tin đã xoá' }),
      ).rejects.toThrow('Tin nhắn đã bị xoá, không thể chỉnh sửa.');
    });
  });

  describe('deleteMessage', () => {
    it('chặn xoá tin nhắn của người khác (403)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                author_id: 'user-other',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.deleteMessage('user-1', '101')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('soft delete tin nhắn thành công, dọn dẹp Storage objects và emit domain event', async () => {
      const removeStorageMock = jest.fn().mockResolvedValue({ error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        remove: removeStorageMock,
      });

      const deleteAttMock = jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                conversation_id: 'conv-1',
                author_id: 'user-1',
              },
              error: null,
            }),
            update: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'att-1',
                  storage_path: 'conversations/conv-1/file.png',
                },
              ],
              error: null,
            }),
            delete: deleteAttMock,
          };
        }
        return {};
      });

      const res = await service.deleteMessage('user-1', '101');
      expect(res.deleted).toBe(true);
      expect(res.id).toBe('101');
      expect(removeStorageMock).toHaveBeenCalledWith(['conversations/conv-1/file.png']);
      expect(deleteAttMock).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_DELETED,
        {
          conversationId: 'conv-1',
          channelId: null,
          messageId: '101',
        },
      );
    });

    it('xử lý khi query attachments trả lỗi: ném 500, không soft-delete và không emit event', async () => {
      const updateMsgMock = jest.fn();

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                conversation_id: 'conv-1',
                author_id: 'user-1',
              },
              error: null,
            }),
            update: updateMsgMock,
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: null,
              error: { message: 'Database connection failed' },
            }),
          };
        }
        return {};
      });

      await expect(service.deleteMessage('user-1', '101')).rejects.toThrow(
        InternalServerErrorException,
      );

      expect(updateMsgMock).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('xử lý khi storage remove trả lỗi: ném 500, không soft-delete và không emit event', async () => {
      const removeStorageMock = jest.fn().mockResolvedValue({
        error: { message: 'Storage connection timeout' },
      });
      mockSupabase.client.storage.from.mockReturnValue({
        remove: removeStorageMock,
      });
      const updateMsgMock = jest.fn();

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                conversation_id: 'conv-1',
                author_id: 'user-1',
              },
              error: null,
            }),
            update: updateMsgMock,
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'att-1',
                  storage_path: 'conversations/conv-1/file.png',
                },
              ],
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(service.deleteMessage('user-1', '101')).rejects.toThrow(
        InternalServerErrorException,
      );

      expect(removeStorageMock).toHaveBeenCalled();
      expect(updateMsgMock).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('xử lý khi delete metadata attachments lỗi: ném 500, không soft-delete và không emit event', async () => {
      const removeStorageMock = jest.fn().mockResolvedValue({ error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        remove: removeStorageMock,
      });
      const updateMsgMock = jest.fn();

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                conversation_id: 'conv-1',
                author_id: 'user-1',
              },
              error: null,
            }),
            update: updateMsgMock,
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'att-1',
                  storage_path: 'conversations/conv-1/file.png',
                },
              ],
              error: null,
            }),
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                error: { message: 'Foreign key constraint error' },
              }),
            }),
          };
        }
        return {};
      });

      await expect(service.deleteMessage('user-1', '101')).rejects.toThrow(
        InternalServerErrorException,
      );

      expect(removeStorageMock).toHaveBeenCalled();
      expect(updateMsgMock).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getAttachmentSignedUrl', () => {
    it('chặn người dùng không phải thành viên cuộc trò chuyện (403 Forbidden)', async () => {
      mockConversationsService.verifyMembership.mockResolvedValueOnce(false);

      await expect(
        service.getAttachmentSignedUrl('intruder', 'conv-1', 'att-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('báo lỗi 404 NotFound nếu attachment không tồn tại hoặc sai conversation', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: null,
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(
        service.getAttachmentSignedUrl('user-1', 'conv-1', 'att-non-existent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('báo lỗi 404 NotFound nếu tin nhắn chứa attachment đã bị soft-deleted', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'att-1',
                storage_path: 'conversations/conv-1/file.png',
                message_id: '101',
                messages: {
                  conversation_id: 'conv-1',
                  deleted_at: '2026-08-22T10:00:00Z',
                },
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.getAttachmentSignedUrl('user-1', 'conv-1', 'att-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('trả về signed URL mới khi attachment hợp lệ', async () => {
      mockSupabase.client.storage.from.mockReturnValue({
        createSignedUrl: jest.fn().mockResolvedValue({
          data: { signedUrl: 'https://storage.supabase.co/signed/refreshed.png' },
          error: null,
        }),
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'att-1',
                storage_path: 'conversations/conv-1/refreshed.png',
                message_id: '101',
                messages: {
                  conversation_id: 'conv-1',
                  deleted_at: null,
                },
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.getAttachmentSignedUrl('user-1', 'conv-1', 'att-1');
      expect(res.signedUrl).toBe('https://storage.supabase.co/signed/refreshed.png');
    });
  });

  describe('isValidEmoji', () => {
    it('chấp nhận các emoji hợp lệ đơn lẻ, skin tone, variation selector và ZWJ', () => {
      expect(isValidEmoji('❤️')).toBe(true);
      expect(isValidEmoji('👍')).toBe(true);
      expect(isValidEmoji('😂')).toBe(true);
      expect(isValidEmoji('🔥')).toBe(true);
      expect(isValidEmoji('🎉')).toBe(true);
      expect(isValidEmoji('🌿')).toBe(true);
      expect(isValidEmoji('👍🏽')).toBe(true); // Skin tone
      expect(isValidEmoji('👨‍👩‍👧‍👦')).toBe(true); // ZWJ sequence
      expect(isValidEmoji('✨')).toBe(true);
    });

    it('từ chối các chuỗi không phải emoji đơn lẻ hoặc không hợp lệ', () => {
      expect(isValidEmoji('')).toBe(false);
      expect(isValidEmoji('hello')).toBe(false);
      expect(isValidEmoji('👍👍')).toBe(false);
      expect(isValidEmoji('<script>alert(1)</script>')).toBe(false);
      expect(isValidEmoji('https://evil.com')).toBe(false);
      expect(isValidEmoji('a'.repeat(50))).toBe(false);
      expect(isValidEmoji('\x00\x01')).toBe(false);
      expect(isValidEmoji('❤️ text')).toBe(false);
    });
  });

  describe('setReaction', () => {
    const convId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const messageId = '101';
    const userId = 'u-1';

    beforeEach(() => {
      mockConversationsService.verifyMembership.mockResolvedValue(true);
    });

    it('ném BadRequestException nếu emoji không hợp lệ', async () => {
      await expect(
        service.setReaction(userId, convId, messageId, {
          emoji: 'not_an_emoji',
          reacted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('ném ForbiddenException nếu người dùng không phải thành viên cuộc trò chuyện', async () => {
      mockConversationsService.verifyMembership.mockResolvedValue(false);

      await expect(
        service.setReaction(userId, convId, messageId, {
          emoji: '❤️',
          reacted: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('ném NotFoundException nếu tin nhắn không tồn tại', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.setReaction(userId, convId, messageId, {
          emoji: '❤️',
          reacted: true,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('ném BadRequestException nếu tin nhắn thuộc cuộc trò chuyện khác', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: messageId, conversation_id: 'other-conv', deleted_at: null },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.setReaction(userId, convId, messageId, {
          emoji: '❤️',
          reacted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('ném BadRequestException nếu tin nhắn đã bị xoá', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: messageId,
                conversation_id: convId,
                deleted_at: '2026-08-23T10:00:00Z',
              },
              error: null,
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.setReaction(userId, convId, messageId, {
          emoji: '❤️',
          reacted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('thêm reaction thành công (reacted: true), emit event và trả về canonical summary', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: messageId, conversation_id: convId, deleted_at: null },
              error: null,
            }),
          };
        }
        if (table === 'message_reactions') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue({
                data: [{ message_id: messageId }],
                error: null,
              }),
            }),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [{ emoji: '❤️', user_id: userId }],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const clientMutationId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
      const res = await service.setReaction(userId, convId, messageId, {
        emoji: '❤️',
        reacted: true,
        clientMutationId,
      });

      expect(res.messageId).toBe(messageId);
      expect(res.conversationId).toBe(convId);
      expect(res.clientMutationId).toBe(clientMutationId);
      expect(res.reactions).toEqual([{ emoji: '❤️', count: 1, reactedByMe: true }]);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.REACTION_UPDATED,
        expect.objectContaining({
          conversationId: convId,
          messageId,
          actorUserId: userId,
          emoji: '❤️',
          action: 'added',
          clientMutationId,
          reactions: [{ emoji: '❤️', count: 1 }],
        }),
      );
    });

    it('idempotent retry thêm reaction khi row đã tồn tại: trả canonical summary, KHÔNG emit fake broadcast', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: messageId, conversation_id: convId, deleted_at: null },
              error: null,
            }),
          };
        }
        if (table === 'message_reactions') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue({
                data: null,
                error: { code: '23505', message: 'duplicate key' },
              }),
            }),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [{ emoji: '❤️', user_id: userId }],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.setReaction(userId, convId, messageId, {
        emoji: '❤️',
        reacted: true,
      });

      expect(res.reactions).toEqual([{ emoji: '❤️', count: 1, reactedByMe: true }]);
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
        CHAT_EVENTS.REACTION_UPDATED,
        expect.anything(),
      );
    });

    it('xoá reaction thành công (reacted: false), emit event và trả về canonical summary', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: messageId, conversation_id: convId, deleted_at: null },
              error: null,
            }),
          };
        }
        if (table === 'message_reactions') {
          return {
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnThis(),
              select: jest.fn().mockResolvedValue({
                data: [{ message_id: messageId }],
                error: null,
              }),
            }),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const clientMutationId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e';
      const res = await service.setReaction(userId, convId, messageId, {
        emoji: '❤️',
        reacted: false,
        clientMutationId,
      });

      expect(res.reactions).toEqual([]);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.REACTION_UPDATED,
        expect.objectContaining({
          conversationId: convId,
          messageId,
          actorUserId: userId,
          emoji: '❤️',
          action: 'removed',
          clientMutationId,
          reactions: [],
        }),
      );
    });

    it('idempotent retry xoá reaction khi row không tồn tại: trả canonical summary, KHÔNG emit fake broadcast', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: messageId, conversation_id: convId, deleted_at: null },
              error: null,
            }),
          };
        }
        if (table === 'message_reactions') {
          return {
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnThis(),
              select: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.setReaction(userId, convId, messageId, {
        emoji: '❤️',
        reacted: false,
      });

      expect(res.reactions).toEqual([]);
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
        CHAT_EVENTS.REACTION_UPDATED,
        expect.anything(),
      );
    });
  });
});
