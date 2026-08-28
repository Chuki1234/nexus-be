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
import { ServerPermissionsService } from '../servers/server-permissions.service';
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
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ data: [], error: null }),
        in: jest.fn().mockResolvedValue({ data: [], error: null }),
      }),
      in: jest.fn().mockResolvedValue({ data: [], error: null }),
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({ data: [], error: null }),
      }),
      delete: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    };
  }
  if (table === 'message_external_media') {
    return {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ data: [], error: null }),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
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
    in: jest.fn().mockResolvedValue({ data: [], error: null }),
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
  let mockConversationsService: {
    verifyMembership: jest.Mock;
    getRequestState: jest.Mock;
  };
  let mockEventEmitter: { emit: jest.Mock };
  let mockServerPermissionsService: {
    assertChannelView: jest.Mock;
    assertChannelSend: jest.Mock;
    assertChannelAttach: jest.Mock;
    assertChannelManage: jest.Mock;
    getChannelPermissions: jest.Mock;
  };

  beforeEach(async () => {
    mockSupabase = {
      client: {
        from: jest
          .fn()
          .mockImplementation((table: string) => defaultTableHandler(table)),
        rpc: jest.fn().mockImplementation((name: string, params: any) => {
          if (name === 'create_conversation_message') {
            const returnedId =
              params.p_client_nonce === 'nonce-gif'
                ? '201'
                : params.p_client_nonce === 'nonce-456'
                  ? '9007199254740999999'
                  : params.p_client_nonce === 'nonce-1'
                    ? '200'
                    : params.p_client_nonce === 'nonce-att'
                      ? '200'
                      : params.p_client_nonce === 'nonce-sec'
                        ? '200'
                        : params.p_client_nonce === 'nonce-docx'
                          ? '1002'
                          : params.p_content === 'Check ảnh này nhé'
                            ? '12345'
                            : params.p_attachments?.length && !params.p_content
                              ? '12346'
                              : params.p_content?.includes('GIF')
                                ? '2001'
                                : '1001';

            return Promise.resolve({
              data: {
                id: returnedId,
                conversationId: params.p_conversation_id,
                authorId: params.p_author_id,
                content: params.p_content,
                type: 'default',
                isForwarded: params.p_is_forwarded || false,
                replyToId: params.p_reply_to_id
                  ? params.p_reply_to_id.toString()
                  : null,
                clientNonce: params.p_client_nonce,
                externalMedia: params.p_external_media || null,
                attachments: params.p_attachments || [],
                reactions: [],
                createdAt: '2026-08-25T12:00:00.000Z',
              },
              error: null,
            });
          }
          if (name === 'create_channel_message') {
            return Promise.resolve({
              data: {
                id: '2001',
                channelId: params.p_channel_id,
                authorId: params.p_author_id,
                content: params.p_content,
                type: 'default',
                isForwarded: params.p_is_forwarded || false,
                replyToId: params.p_reply_to_id
                  ? params.p_reply_to_id.toString()
                  : null,
                clientNonce: params.p_client_nonce,
                externalMedia: params.p_external_media || null,
                attachments: params.p_attachments || [],
                reactions: [],
                createdAt: '2026-08-25T12:00:00.000Z',
              },
              error: null,
            });
          }
          if (name === 'create_forwarded_message') {
            return Promise.resolve({
              data: [
                {
                  message_id: '200',
                  conversation_id: params.p_conversation_id,
                  author_id: params.p_author_id,
                  content: params.p_content,
                  type: 'default',
                  is_forwarded: true,
                  reply_to_id: null,
                  client_nonce: params.p_client_nonce,
                  edited_at: null,
                  deleted_at: null,
                  created_at: '2026-08-23T15:00:00.000Z',
                  attachments: (params.p_attachments || []).map(
                    (att: any, idx: number) => ({
                      id: `att-target-${idx + 1}`,
                      message_id: '200',
                      storage_path: att.storage_path,
                      filename: att.filename,
                      mime_type: att.mime_type,
                      size_bytes: att.size_bytes,
                      width: att.width,
                      height: att.height,
                      created_at: '2026-08-23T15:00:00.000Z',
                    }),
                  ),
                },
              ],
              error: null,
            });
          }
          if (name === 'get_conversation_messages_paged') {
            return Promise.resolve({
              data: [
                {
                  id: '9007199254740999999',
                  channel_id: null,
                  conversation_id: params.p_conversation_id,
                  author_id: 'user-1',
                  type: 'default',
                  content: 'Hello Huge BigInt',
                  reply_to_id: null,
                  client_nonce: 'nonce-huge',
                  edited_at: null,
                  deleted_at: null,
                  created_at: '2026-08-22T10:00:00Z',
                },
              ],
              error: null,
            });
          }
          if (name === 'get_channel_messages_paged') {
            return Promise.resolve({
              data: [
                {
                  id: '6001',
                  channel_id: params.p_channel_id,
                  conversation_id: null,
                  author_id: 'user-1',
                  type: 'default',
                  content: null,
                  reply_to_id: null,
                  client_nonce: 'nonce-gif-msg',
                  edited_at: null,
                  deleted_at: null,
                  created_at: '2026-08-25T12:00:00Z',
                },
              ],
              error: null,
            });
          }
          if (name === 'hide_message_for_user') {
            return Promise.resolve({
              data: {
                id: params.p_message_id?.toString() || '101',
                conversationId: 'conv-1',
                channelId: null,
                hidden: true,
              },
              error: null,
            });
          }
          if (name === 'recall_message_for_everyone') {
            return Promise.resolve({
              data: {
                id: params.p_message_id?.toString() || '101',
                conversationId: 'conv-1',
                channelId: null,
                recalled: true,
                storagePaths: ['conversations/conv-1/file.png'],
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
        storage: {
          from: jest.fn().mockReturnValue({
            upload: jest.fn().mockResolvedValue({ error: null }),
            remove: jest.fn().mockResolvedValue({ error: null }),
            createSignedUrls: jest
              .fn()
              .mockImplementation((paths: string[]) => {
                return Promise.resolve({
                  data: (paths || []).map((p) => ({
                    path: p,
                    signedUrl: `https://storage.supabase.co/signed/${p.split('/').pop()}`,
                  })),
                  error: null,
                });
              }),
            getPublicUrl: jest.fn().mockReturnValue({
              data: {
                publicUrl: 'https://storage.supabase.co/public/test.png',
              },
            }),
          }),
        },
      },
    };

    mockConversationsService = {
      verifyMembership: jest.fn().mockResolvedValue(true),
      getRequestState: jest.fn().mockResolvedValue('accepted'),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockServerPermissionsService = {
      assertChannelView: jest.fn().mockResolvedValue(undefined),
      assertChannelSend: jest.fn().mockResolvedValue(undefined),
      assertChannelAttach: jest.fn().mockResolvedValue(undefined),
      assertChannelManage: jest.fn().mockResolvedValue(undefined),
      getChannelPermissions: jest.fn().mockResolvedValue(~0n),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagesService,
        { provide: SupabaseService, useValue: mockSupabase },
        { provide: ConversationsService, useValue: mockConversationsService },
        {
          provide: ServerPermissionsService,
          useValue: mockServerPermissionsService,
        },
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
            maybeSingle: jest
              .fn()
              .mockResolvedValue({ data: null, error: null }),
          };
        }
        return defaultTableHandler(table);
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
        return defaultTableHandler(table);
      });

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {
          content: 'Reply chéo conversation',
          replyToId: '888',
        }),
      ).rejects.toThrow(
        'Tin nhắn được trả lời không thuộc cuộc trò chuyện này.',
      );
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
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint',
                  },
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

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
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
                // Kiểm tra tin nhắn reply tồn tại
                return Promise.resolve({
                  data: {
                    id: '9007199254740999888',
                    conversation_id: 'conv-1',
                  },
                  error: null,
                });
              }
              // Pre-check clientNonce: không có tin nhắn trùng
              return Promise.resolve({ data: null, error: null });
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
      expect(mockSupabase.client.rpc).toHaveBeenCalledWith(
        'create_conversation_message',
        expect.objectContaining({
          p_reply_to_id: BigInt('9007199254740999888'),
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
        service.createConversationMessage('user-1', 'conv-1', {}, [
          fakePngFile,
        ]),
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

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: 'Lỗi lưu thông tin tập tin đính kèm.',
          code: '22023',
        },
      });

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [mockFile]),
      ).rejects.toThrow('Lỗi lưu thông tin tập tin đính kèm.');
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

      let selectNonceCount = 0;
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockImplementation(() => {
              selectNonceCount++;
              // Lần 1: check trước insert không thấy; Lần 2: sau 23505 thấy dupMsg
              return Promise.resolve({
                data: selectNonceCount === 1 ? null : dupMsg,
                error: null,
              });
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

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
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
        buffer: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]),
        originalname: 'corrupt.png',
        mimetype: 'image/png',
        size: 1024,
      } as Express.Multer.File;

      await expect(
        service.createConversationMessage('user-1', 'conv-1', {}, [
          corruptedFile,
        ]),
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
      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
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
              maybeSingle: jest
                .fn()
                .mockResolvedValue({ data: null, error: null }),
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

      mockSupabase.client.rpc.mockImplementationOnce(
        (name: string, params: any) => {
          if (params.p_attachments) {
            insertedAttachmentRows.push(...params.p_attachments);
          }
          return Promise.resolve({
            data: {
              id: '2001',
              conversationId: params.p_conversation_id,
              authorId: params.p_author_id,
              content: params.p_content,
              type: 'default',
              isForwarded: false,
              replyToId: null,
              clientNonce: null,
              externalMedia: null,
              attachments: params.p_attachments || [],
              reactions: [],
              createdAt: '2026-08-25T12:00:00.000Z',
            },
            error: null,
          });
        },
      );

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
      expect(normalizeFilename('../../secret/passwords.txt')).toBe(
        'passwords.txt',
      );
      expect(normalizeFilename('file\x00\x1f\x7fname.png')).toBe(
        'filename.png',
      );
    });

    it('formatContentDisposition tuân thủ RFC 5987 / RFC 6266 và chống CRLF injection', () => {
      const result = formatContentDisposition(
        'Báo cáo kỳ 2.pdf\r\nInjected-Header: evil',
      );
      expect(result).not.toContain('\r');
      expect(result).not.toContain('\n');
      expect(result).toContain(
        'filename="B_o c_o k_ 2.pdf__Injected-Header: evil"',
      );
      expect(result).toContain(
        "filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20k%E1%BB%B3%202.pdf__Injected-Header%3A%20evil",
      );
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
        error: {
          code: '42501',
          message: 'User is not a participant of this conversation',
        },
      });

      await expect(
        service.markAsRead('user-intruder', 'conv-1', '9999'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('báo lỗi 400 BadRequest nếu RPC trả lỗi 22023 (tin nhắn không tồn tại hoặc sai conv)', async () => {
      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: null,
        error: {
          code: '22023',
          message: 'Message does not exist in this conversation',
        },
      });

      await expect(
        service.markAsRead('user-1', 'conv-1', '100'),
      ).rejects.toThrow(BadRequestException);
    });

    it('không emit CHAT_EVENTS.MESSAGE_READ nếu RPC trả updated=false (stale hoặc lùi read-state)', async () => {
      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: [
          {
            success: true,
            updated: false,
            last_read_message_id: '9007199254740999200',
          },
        ],
        error: null,
      });

      const res = await service.markAsRead(
        'user-1',
        'conv-1',
        '9007199254740999100',
      );
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
                created_at: new Date().toISOString(),
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
                created_at: new Date().toISOString(),
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

    it('chặn chỉnh sửa khi đã hết thời gian 5 phút (ConflictException)', async () => {
      const pastTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 phút trước
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                author_id: 'user-1',
                deleted_at: null,
                created_at: pastTime,
                content: 'Tin cũ',
                type: 'default',
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await expect(
        service.editMessage('user-1', '101', { content: 'Sửa tin cũ' }),
      ).rejects.toThrow('Đã hết thời gian chỉnh sửa tin nhắn (5 phút).');
    });

    it('cho phép chỉnh sửa khi còn trong cửa sổ 5 phút và broadcast event', async () => {
      const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 phút trước
      const existingRow = {
        id: '101',
        channel_id: 'chan-1',
        conversation_id: null,
        author_id: 'user-1',
        type: 'default',
        content: 'Nội dung cũ',
        is_forwarded: false,
        reply_to_id: null,
        client_nonce: 'nonce-101',
        edited_at: null,
        deleted_at: null,
        created_at: recentTime,
      };
      const updatedRow = {
        ...existingRow,
        content: 'Nội dung mới đã sửa',
        edited_at: new Date().toISOString(),
      };

      let messageQueryCount = 0;
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            gt: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockImplementation(() => {
              messageQueryCount++;
              if (messageQueryCount === 1) {
                return Promise.resolve({ data: existingRow, error: null });
              }
              return Promise.resolve({ data: updatedRow, error: null });
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
                username: 'alice',
                display_name: 'Alice',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'attachments' || table === 'message_external_media') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      });

      const res = await service.editMessage('user-1', '101', {
        content: 'Nội dung mới đã sửa',
      });
      expect(res.content).toBe('Nội dung mới đã sửa');
      expect(res.editedAt).toBeTruthy();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_UPDATED,
        expect.objectContaining({
          channelId: 'chan-1',
          message: expect.objectContaining({
            id: '101',
            content: 'Nội dung mới đã sửa',
          }),
        }),
      );
    });

    it('cho phép chỉnh sửa text và thêm attachment trong cùng một thao tác', async () => {
      const recentTime = new Date(Date.now() - 60_000).toISOString();
      const existingRow = {
        id: '101',
        channel_id: null,
        conversation_id: 'conv-1',
        author_id: 'user-1',
        type: 'default',
        content: 'Nội dung cũ',
        is_forwarded: false,
        reply_to_id: null,
        client_nonce: 'nonce-101',
        edited_at: null,
        deleted_at: null,
        created_at: recentTime,
      };
      const updatedRow = {
        ...existingRow,
        content: 'Nội dung và ảnh mới',
        edited_at: new Date().toISOString(),
      };
      const pngBuffer = await sharp({
        create: { width: 2, height: 2, channels: 4, background: '#00ff88' },
      })
        .png()
        .toBuffer();
      const upload = jest.fn().mockResolvedValue({ error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        upload,
        remove: jest.fn().mockResolvedValue({ error: null }),
        createSignedUrls: jest.fn().mockResolvedValue({
          data: [
            {
              path: 'conversations/conv-1/new.png',
              signedUrl: 'https://storage.test/new.png',
            },
          ],
          error: null,
        }),
      });

      let messageQueryCount = 0;
      const insertAttachments = jest.fn().mockResolvedValue({ error: null });
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            gt: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockImplementation(() => {
              messageQueryCount++;
              return Promise.resolve({
                data: messageQueryCount === 1 ? existingRow : updatedRow,
                error: null,
              });
            }),
          };
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
              in: jest.fn().mockResolvedValue({
                data: [
                  {
                    id: 'att-new',
                    message_id: '101',
                    storage_path: 'conversations/conv-1/new.png',
                    filename: 'clipboard.png',
                    mime_type: 'image/png',
                    size_bytes: pngBuffer.length,
                    width: 2,
                    height: 2,
                    created_at: recentTime,
                  },
                ],
                error: null,
              }),
            }),
            insert: insertAttachments,
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'alice',
                display_name: 'Alice',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'message_external_media') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return defaultTableHandler(table);
      });

      const file = {
        fieldname: 'files',
        originalname: 'clipboard.png',
        encoding: '7bit',
        mimetype: 'image/png',
        size: pngBuffer.length,
        buffer: pngBuffer,
      } as Express.Multer.File;

      const result = await service.editMessage(
        'user-1',
        '101',
        { content: 'Nội dung và ảnh mới' },
        [file],
      );

      expect(upload).toHaveBeenCalled();
      expect(insertAttachments).toHaveBeenCalledWith([
        expect.objectContaining({
          message_id: '101',
          filename: 'clipboard.png',
          mime_type: 'image/png',
        }),
      ]);
      expect(result.content).toBe('Nội dung và ảnh mới');
      expect(result.attachments).toHaveLength(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_UPDATED,
        expect.objectContaining({
          conversationId: 'conv-1',
          message: expect.objectContaining({ attachments: expect.any(Array) }),
        }),
      );
    });

    it('no-op khi nội dung giống hệt: không update DB, không emit event, trả DTO đầy đủ', async () => {
      const recentTime = new Date(Date.now() - 1 * 60 * 1000).toISOString();
      mockEventEmitter.emit.mockClear();

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: '101',
                channel_id: 'chan-1',
                conversation_id: null,
                author_id: 'user-1',
                type: 'default',
                content: 'Không đổi',
                is_forwarded: false,
                reply_to_id: null,
                client_nonce: 'nonce-101',
                edited_at: null,
                deleted_at: null,
                created_at: recentTime,
              },
              error: null,
            }),
            update: jest.fn(),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-1',
                username: 'alice',
                display_name: 'Alice',
                avatar_url: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'attachments' || table === 'message_external_media') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      });

      const res = await service.editMessage('user-1', '101', {
        content: '  Không đổi  ',
      });
      expect(res.content).toBe('Không đổi');
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_UPDATED,
        expect.anything(),
      );
    });
  });

  describe('deleteMessage', () => {
    it('hideMessageForUser: gọi RPC hide_message_for_user và emit user-scoped CHAT_EVENTS.MESSAGE_HIDDEN_FOR_USER', async () => {
      const res = await service.hideMessageForUser('user-1', '101');
      expect(res.hidden).toBe(true);
      expect(res.scope).toBe('for_me');
      expect(mockSupabase.client.rpc).toHaveBeenCalledWith(
        'hide_message_for_user',
        {
          p_user_id: 'user-1',
          p_message_id: 101,
        },
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_HIDDEN_FOR_USER,
        {
          userId: 'user-1',
          messageId: '101',
          conversationId: 'conv-1',
          channelId: null,
        },
      );
    });

    it('recallMessageForEveryone: gọi RPC recall_message_for_everyone và emit CHAT_EVENTS.MESSAGE_DELETED', async () => {
      const res = await service.recallMessageForEveryone('user-1', '101');
      expect(res.deleted).toBe(true);
      expect(res.scope).toBe('everyone');
      expect(mockSupabase.client.rpc).toHaveBeenCalledWith(
        'recall_message_for_everyone',
        {
          p_user_id: 'user-1',
          p_message_id: 101,
        },
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_DELETED,
        {
          conversationId: 'conv-1',
          channelId: null,
          messageId: '101',
        },
      );
    });

    it('deleteMessage with scope="for_me" delegates to hideMessageForUser', async () => {
      const spy = jest
        .spyOn(service, 'hideMessageForUser')
        .mockResolvedValueOnce({
          id: '101',
          hidden: true,
          scope: 'for_me',
          conversationId: 'conv-1',
          channelId: null,
        });

      const res = await service.deleteMessage('user-1', '101', 'for_me');
      expect(spy).toHaveBeenCalledWith('user-1', '101');
      expect(res.hidden).toBe(true);
    });

    it('deleteMessage with scope="everyone" delegates to recallMessageForEveryone', async () => {
      const spy = jest
        .spyOn(service, 'recallMessageForEveryone')
        .mockResolvedValueOnce({
          id: '101',
          deleted: true,
          scope: 'everyone',
          conversationId: 'conv-1',
          channelId: null,
        });

      const res = await service.deleteMessage('user-1', '101', 'everyone');
      expect(spy).toHaveBeenCalledWith('user-1', '101');
      expect(res.deleted).toBe(true);
    });

    it('deleteMessage ném BadRequestException khi scope không hợp lệ', async () => {
      await expect(
        service.deleteMessage('user-1', '101', 'invalid_scope' as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('xử lý khi RPC trả lỗi P0002 -> NotFoundException', async () => {
      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'Not found' },
      });

      await expect(service.hideMessageForUser('user-1', '999')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('xử lý khi RPC trả lỗi 42501 -> ForbiddenException', async () => {
      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'Permission denied' },
      });

      await expect(
        service.recallMessageForEveryone('user-2', '101'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('xử lý khi RPC trả lỗi database khác -> 500 InternalServerErrorException', async () => {
      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'XX000', message: 'Internal DB crash' },
      });

      await expect(service.hideMessageForUser('user-1', '101')).rejects.toThrow(
        InternalServerErrorException,
      );
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
          data: {
            signedUrl: 'https://storage.supabase.co/signed/refreshed.png',
          },
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

      const res = await service.getAttachmentSignedUrl(
        'user-1',
        'conv-1',
        'att-1',
      );
      expect(res.signedUrl).toBe(
        'https://storage.supabase.co/signed/refreshed.png',
      );
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
            maybeSingle: jest
              .fn()
              .mockResolvedValue({ data: null, error: null }),
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
              data: {
                id: messageId,
                conversation_id: 'other-conv',
                deleted_at: null,
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
              data: {
                id: messageId,
                conversation_id: convId,
                deleted_at: null,
              },
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
      expect(res.reactions).toEqual([
        { emoji: '❤️', count: 1, reactedByMe: true },
      ]);

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
              data: {
                id: messageId,
                conversation_id: convId,
                deleted_at: null,
              },
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

      expect(res.reactions).toEqual([
        { emoji: '❤️', count: 1, reactedByMe: true },
      ]);
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
              data: {
                id: messageId,
                conversation_id: convId,
                deleted_at: null,
              },
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
              data: {
                id: messageId,
                conversation_id: convId,
                deleted_at: null,
              },
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

  describe('forwardConversationMessage (Compensating Workflow & Idempotency)', () => {
    const userId = '11111111-1111-4111-a111-111111111111';
    const sourceConvId = '22222222-2222-4222-a222-222222222222';
    const targetConvId = '33333333-3333-4333-a333-333333333333';
    const sourceMsgId = '100';

    function createMessagesMock({
      sourceMsg,
      targetMsg,
      existingNonceMsg,
      insertError,
    }: {
      sourceMsg?: any;
      targetMsg?: any;
      existingNonceMsg?: any;
      insertError?: any;
    }) {
      let nonceQueryCount = 0;
      const builder: any = {
        filters: {} as Record<string, any>,
        select: jest.fn().mockImplementation(() => {
          const selectBuilder = { ...builder, filters: {} };
          selectBuilder.eq = jest
            .fn()
            .mockImplementation((col: string, val: any) => {
              selectBuilder.filters[col] = val;
              return selectBuilder;
            });
          selectBuilder.maybeSingle = jest.fn().mockImplementation(async () => {
            if (selectBuilder.filters.id) {
              return { data: sourceMsg ?? null, error: null };
            }
            if (selectBuilder.filters.client_nonce) {
              if (existingNonceMsg !== undefined) {
                return { data: existingNonceMsg, error: null };
              }
              if (nonceQueryCount++ === 0) {
                return { data: null, error: null };
              }
              return { data: targetMsg ?? null, error: null };
            }
            return { data: null, error: null };
          });
          selectBuilder.single = jest.fn().mockImplementation(async () => {
            return { data: targetMsg ?? null, error: null };
          });
          return selectBuilder;
        }),
        insert: jest.fn().mockImplementation(() => ({
          select: jest.fn().mockReturnValue({
            single: jest.fn().mockImplementation(async () => {
              if (insertError) {
                return { data: null, error: insertError };
              }
              return { data: targetMsg ?? null, error: null };
            }),
          }),
        })),
        delete: jest.fn().mockImplementation(() => ({
          eq: jest.fn().mockResolvedValue({ data: [], error: null }),
        })),
      };
      return builder;
    }

    beforeEach(() => {
      jest.clearAllMocks();
      mockConversationsService.verifyMembership.mockResolvedValue(true);
    });

    it('1. forward text thành công: tạo message mới tại target, isForwarded=true, author là người gửi', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        author_id: 'other-user',
        content: 'Tin nhắn gốc cần forward',
        deleted_at: null,
      };

      const mockCreatedTargetMsg = {
        id: 200,
        channel_id: null,
        conversation_id: targetConvId,
        author_id: userId,
        type: 'default',
        content: 'Tin nhắn gốc cần forward',
        is_forwarded: true,
        reply_to_id: null,
        client_nonce: 'nonce-1',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-23T15:00:00.000Z',
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
            targetMsg: mockCreatedTargetMsg,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
              in: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    id: userId,
                    username: 'minhtai',
                    display_name: 'Minh Tài',
                    avatar_url: null,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.forwardConversationMessage(
        userId,
        sourceConvId,
        sourceMsgId,
        {
          targetConversationId: targetConvId,
          clientNonce: 'nonce-1',
        },
      );

      expect(res.id).toBe('200');
      expect(res.conversationId).toBe(targetConvId);
      expect(res.authorId).toBe(userId);
      expect(res.isForwarded).toBe(true);
      expect(res.content).toBe('Tin nhắn gốc cần forward');
      expect(res.replyToId).toBeNull();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_CREATED,
        expect.objectContaining({
          conversationId: targetConvId,
          message: expect.objectContaining({
            id: '200',
            isForwarded: true,
          }),
        }),
      );
    });

    it('2. forward ảnh/GIF/file: copy storage sang target path mới, bảo toàn metadata & signed URLs', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: null,
        deleted_at: null,
      };

      const mockSourceAttachment = {
        id: 'att-source-1',
        message_id: 100,
        storage_path: `conversations/${sourceConvId}/uuid-original.gif`,
        filename: 'Tài_liệu_animation.gif',
        mime_type: 'image/gif',
        size_bytes: 2500000,
        width: 800,
        height: 600,
      };

      const mockTargetMsg = {
        id: 201,
        channel_id: null,
        conversation_id: targetConvId,
        author_id: userId,
        type: 'default',
        content: null,
        is_forwarded: true,
        client_nonce: 'nonce-gif',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-23T15:00:00.000Z',
      };

      const mockCreatedTargetAttachment = {
        id: 'att-target-1',
        message_id: 201,
        storage_path: `conversations/${targetConvId}/new-uuid.gif`,
        filename: 'Tài_liệu_animation.gif',
        mime_type: 'image/gif',
        size_bytes: 2500000,
        width: 800,
        height: 600,
      };

      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest
          .fn()
          .mockResolvedValue({ data: { path: 'copied' }, error: null }),
        remove: jest.fn().mockResolvedValue({ data: [], error: null }),
        createSignedUrl: jest.fn().mockResolvedValue({
          data: { signedUrl: 'https://storage.target.signed/new-uuid.gif' },
          error: null,
        }),
        createSignedUrls: jest.fn().mockImplementation((paths: string[]) => {
          return Promise.resolve({
            data: (paths || []).map((p) => ({
              path: p,
              signedUrl: 'https://storage.target.signed/new-uuid.gif',
            })),
            error: null,
          });
        }),
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
            targetMsg: mockTargetMsg,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [mockSourceAttachment],
                error: null,
              }),
              in: jest.fn().mockResolvedValue({
                data: [mockCreatedTargetAttachment],
                error: null,
              }),
            }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockResolvedValue({
                data: [mockCreatedTargetAttachment],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: {
                    id: userId,
                    username: 'minhtai',
                    display_name: 'Minh Tài',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.forwardConversationMessage(
        userId,
        sourceConvId,
        sourceMsgId,
        {
          targetConversationId: targetConvId,
          clientNonce: 'nonce-gif',
        },
      );

      expect(res.attachments).toBeDefined();
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].filename).toBe('Tài_liệu_animation.gif');
      expect(res.attachments?.[0].mimeType).toBe('image/gif');
      expect(res.attachments?.[0].sizeBytes).toBe(2500000);
      expect(res.attachments?.[0].width).toBe(800);
      expect(res.attachments?.[0].height).toBe(600);
      expect(res.attachments?.[0].signedUrl).toBe(
        'https://storage.target.signed/new-uuid.gif',
      );
      expect(mockSupabase.client.rpc).toHaveBeenCalledWith(
        'create_conversation_message',
        expect.objectContaining({
          p_attachments: [
            expect.objectContaining({
              storagePath: expect.stringContaining(
                `conversations/${targetConvId}/`,
              ),
              filename: 'Tài_liệu_animation.gif',
              mimeType: 'image/gif',
              sizeBytes: 2500000,
              width: 800,
              height: 600,
            }),
          ],
        }),
      );
    });

    it('3. Chặn user không phải thành viên source hoặc target (403 Forbidden)', async () => {
      mockConversationsService.verifyMembership
        .mockResolvedValueOnce(false) // Source check fails
        .mockResolvedValueOnce(true);

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'valid-nonce-403',
        }),
      ).rejects.toThrow(ForbiddenException);

      mockConversationsService.verifyMembership
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false); // Target check fails

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'valid-nonce-403',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('4. Chặn tin nhắn nguồn đã bị soft-deleted (404 NotFoundException)', async () => {
      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: {
              id: 100,
              conversation_id: sourceConvId,
              deleted_at: '2026-08-23T14:00:00.000Z',
            },
          });
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'valid-nonce-404',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('5. Retry tuần tự với cùng clientNonce: trả canonical message, không copy Storage lần 2, không emit socket lần 2', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Nội dung',
        deleted_at: null,
      };

      const existingMessage = {
        id: 202,
        channel_id: null,
        conversation_id: targetConvId,
        author_id: userId,
        type: 'default',
        content: 'Nội dung đã forward',
        is_forwarded: true,
        reply_to_id: null,
        client_nonce: 'existing-nonce-123',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-23T15:00:00.000Z',
      };

      const storageCopySpy = jest.fn();
      mockSupabase.client.storage.from.mockReturnValue({
        copy: storageCopySpy,
        createSignedUrls: jest
          .fn()
          .mockResolvedValue({ data: [], error: null }),
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
            existingNonceMsg: existingMessage,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
              in: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: { id: userId, username: 'minhtai' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.forwardConversationMessage(
        userId,
        sourceConvId,
        sourceMsgId,
        {
          targetConversationId: targetConvId,
          clientNonce: 'existing-nonce-123',
        },
      );

      expect(res.id).toBe('202');
      expect(res.isForwarded).toBe(true);
      // Không copy storage lần 2
      expect(storageCopySpy).not.toHaveBeenCalled();
      // Không emit socket lần 2
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('6. Lỗi copy Storage ở giữa chừng: Compensating Cleanup dọn dẹp các tệp đã copy và ném 500', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Forward error',
        deleted_at: null,
      };

      const mockSourceAttachments = [
        {
          id: 'att-1',
          storage_path: `conversations/${sourceConvId}/file1.jpg`,
          filename: 'file1.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 1000,
        },
        {
          id: 'att-2',
          storage_path: `conversations/${sourceConvId}/file2.jpg`,
          filename: 'file2.jpg',
          mime_type: 'image/jpeg',
          size_bytes: 2000,
        },
      ];

      const removeSpy = jest.fn().mockResolvedValue({ data: [], error: null });
      let copyCallCount = 0;
      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest.fn().mockImplementation(async () => {
          copyCallCount++;
          if (copyCallCount === 2) {
            return {
              data: null,
              error: new Error('Storage copy failed on file 2'),
            };
          }
          return { data: { path: 'ok' }, error: null };
        }),
        remove: removeSpy,
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: mockSourceAttachments,
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'nonce-fail-copy',
        }),
      ).rejects.toThrow(InternalServerErrorException);

      // File 1 phải được xóa bù trừ
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining(targetConvId)]),
      );
    });

    it('7. Lỗi RPC create_forwarded_message: Fail-fast, cleanup storage và ném 500 (không chạy fallback)', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Forward error RPC',
        deleted_at: null,
      };

      const mockSourceAttachment = {
        id: 'att-1',
        storage_path: `conversations/${sourceConvId}/file1.jpg`,
        filename: 'file1.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      };

      const removeSpy = jest.fn().mockResolvedValue({ data: [], error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest
          .fn()
          .mockResolvedValue({ data: { path: 'ok' }, error: null }),
        remove: removeSpy,
      });

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'Database connection timeout', code: '500' },
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [mockSourceAttachment],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'nonce-rpc-fail',
        }),
      ).rejects.toThrow(InternalServerErrorException);

      // Storage objects được dọn dẹp bù trừ
      expect(removeSpy).toHaveBeenCalledTimes(1);
      // Không emit socket
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('8. Missing RPC (42883 / PGRST202): Fail-fast với thông báo migration database chưa được triển khai', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Forward missing RPC',
        deleted_at: null,
      };

      const mockSourceAttachment = {
        id: 'att-missing-rpc',
        storage_path: `conversations/${sourceConvId}/file-missing.jpg`,
        filename: 'file-missing.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1200,
      };

      const removeSpy = jest.fn().mockResolvedValue({ data: [], error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest
          .fn()
          .mockResolvedValue({ data: { path: 'ok' }, error: null }),
        remove: removeSpy,
      });

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          message: 'function public.create_forwarded_message does not exist',
          code: '42883',
        },
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [mockSourceAttachment],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'nonce-missing-rpc',
        }),
      ).rejects.toThrow(
        'Chức năng chuyển tiếp tin nhắn chưa sẵn sàng (migration database chưa được triển khai).',
      );

      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('9. Concurrent 23505 race condition: 2 request cùng clientNonce chạy song song -> request thua dọn dẹp CHỈ object của mình và trả canonical message mà không báo 500', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Race condition text',
        deleted_at: null,
      };

      const mockSourceAttachment = {
        id: 'att-1',
        storage_path: `conversations/${sourceConvId}/file.jpg`,
        filename: 'file.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      };

      const winningMessage = {
        id: 300,
        channel_id: null,
        conversation_id: targetConvId,
        author_id: userId,
        type: 'default',
        content: 'Race condition text',
        is_forwarded: true,
        reply_to_id: null,
        client_nonce: 'race-nonce-uuid',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-23T15:00:00.000Z',
      };

      const removeSpy = jest.fn().mockResolvedValue({ data: [], error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest
          .fn()
          .mockResolvedValue({ data: { path: 'ok' }, error: null }),
        remove: removeSpy,
        createSignedUrls: jest.fn().mockResolvedValue({
          data: [
            {
              path: `conversations/${targetConvId}/file.jpg`,
              signedUrl: 'https://storage/winning.jpg',
            },
          ],
          error: null,
        }),
      });

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            'duplicate key value violates unique constraint "idx_messages_nonce"',
          code: '23505',
        },
      });

      const messagesMock = createMessagesMock({
        sourceMsg: mockSourceMsg,
        targetMsg: winningMessage,
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return messagesMock;
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [mockSourceAttachment],
                error: null,
              }),
              in: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: { id: userId, username: 'minhtai' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      // Request thua gặp 23505
      const res = await service.forwardConversationMessage(
        userId,
        sourceConvId,
        sourceMsgId,
        {
          targetConversationId: targetConvId,
          clientNonce: 'race-nonce-uuid',
        },
      );

      // Không ném 500, trả canonical message
      expect(res.id).toBe('300');
      expect(res.clientNonce).toBe('race-nonce-uuid');
      // Dọn dẹp object của request thua cuộc
      expect(removeSpy).toHaveBeenCalledTimes(1);
      // Không emit socket lần 2
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('10. Nonce đã sử dụng cho cuộc trò chuyện khác (409 Conflict): Cleanup storage và ném ConflictException', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Cross-conv conflict',
        deleted_at: null,
      };

      const mockSourceAttachment = {
        id: 'att-1',
        storage_path: `conversations/${sourceConvId}/photo.jpg`,
        filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 5000,
      };

      const crossConvMessage = {
        id: 999,
        channel_id: null,
        conversation_id: 'different-conversation-uuid-999',
        author_id: userId,
        type: 'default',
        content: 'Cross-conv conflict',
        is_forwarded: true,
        reply_to_id: null,
        client_nonce: 'cross-nonce-uuid',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-23T15:00:00.000Z',
      };

      const removeSpy = jest.fn().mockResolvedValue({ data: [], error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest
          .fn()
          .mockResolvedValue({ data: { path: 'ok' }, error: null }),
        remove: removeSpy,
      });

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            'duplicate key value violates unique constraint "idx_messages_nonce"',
          code: '23505',
        },
      });

      const messagesMock = createMessagesMock({
        sourceMsg: mockSourceMsg,
        targetMsg: crossConvMessage,
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return messagesMock;
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [mockSourceAttachment],
                error: null,
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: 'cross-nonce-uuid',
        }),
      ).rejects.toThrow(ConflictException);

      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('11. Target DTO không chứa dữ liệu nhạy cảm của source conversation', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Forward text',
        deleted_at: null,
      };

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return createMessagesMock({
            sourceMsg: mockSourceMsg,
          });
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
              in: jest.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: { id: userId, username: 'minhtai' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.forwardConversationMessage(
        userId,
        sourceConvId,
        sourceMsgId,
        {
          targetConversationId: targetConvId,
          clientNonce: 'nonce-sec',
        },
      );

      expect(res.conversationId).toBe(targetConvId);
      expect((res as any).sourceConversationId).toBeUndefined();
      expect((res as any).sourceSignedUrl).toBeUndefined();
    });

    it('12. Thiếu clientNonce: ném lỗi BadRequestException (400)', async () => {
      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: '' as any,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.forwardConversationMessage(userId, sourceConvId, sourceMsgId, {
          targetConversationId: targetConvId,
          clientNonce: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('13. Hai request đồng thời: request thua chỉ trả canonical sau khi attachments hoàn chỉnh', async () => {
      const mockSourceMsg = {
        id: 100,
        conversation_id: sourceConvId,
        content: 'Race with attachments',
        deleted_at: null,
      };

      const mockSourceAttachment = {
        id: 'att-1',
        storage_path: `conversations/${sourceConvId}/file.pdf`,
        filename: 'document.pdf',
        mime_type: 'application/pdf',
        size_bytes: 15000,
      };

      const canonicalWinningMessage = {
        id: 777,
        channel_id: null,
        conversation_id: targetConvId,
        author_id: userId,
        type: 'default',
        content: 'Race with attachments',
        is_forwarded: true,
        reply_to_id: null,
        client_nonce: 'concurrent-nonce-123',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-23T15:00:00.000Z',
      };

      const canonicalAttachments = [
        {
          id: 'att-winning-1',
          message_id: 777,
          storage_path: `conversations/${targetConvId}/winning-doc.pdf`,
          filename: 'document.pdf',
          mime_type: 'application/pdf',
          size_bytes: 15000,
          width: null,
          height: null,
          created_at: '2026-08-23T15:00:00.000Z',
        },
      ];

      const removeSpy = jest.fn().mockResolvedValue({ data: [], error: null });
      mockSupabase.client.storage.from.mockReturnValue({
        copy: jest
          .fn()
          .mockResolvedValue({ data: { path: 'ok' }, error: null }),
        remove: removeSpy,
        createSignedUrls: jest.fn().mockResolvedValue({
          data: [
            {
              path: `conversations/${targetConvId}/winning-doc.pdf`,
              signedUrl: 'https://storage/canonical-winning-doc.pdf',
            },
          ],
          error: null,
        }),
      });

      mockSupabase.client.rpc.mockResolvedValueOnce({
        data: null,
        error: {
          message:
            'duplicate key value violates unique constraint "idx_messages_nonce"',
          code: '23505',
        },
      });

      const messagesMock = createMessagesMock({
        sourceMsg: mockSourceMsg,
        targetMsg: canonicalWinningMessage,
      });

      mockSupabase.client.from.mockImplementation((table: string) => {
        if (table === 'messages') {
          return messagesMock;
        }
        if (table === 'attachments') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: [mockSourceAttachment],
                error: null,
              }),
              in: jest.fn().mockResolvedValue({
                data: canonicalAttachments,
                error: null,
              }),
            }),
          };
        }
        if (table === 'profiles') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                maybeSingle: jest.fn().mockResolvedValue({
                  data: { id: userId, username: 'minhtai' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return defaultTableHandler(table);
      });

      const res = await service.forwardConversationMessage(
        userId,
        sourceConvId,
        sourceMsgId,
        {
          targetConversationId: targetConvId,
          clientNonce: 'concurrent-nonce-123',
        },
      );

      // Request thua cuộc nhận canonical message kèm đầy đủ attachments
      expect(res.id).toBe('777');
      expect(res.isForwarded).toBe(true);
      expect(res.attachments).toBeDefined();
      expect(res.attachments?.length).toBe(1);
      expect(res.attachments?.[0].filename).toBe('document.pdf');
      expect(res.attachments?.[0].signedUrl).toBe(
        'https://storage/canonical-winning-doc.pdf',
      );
      // Request thua dọn dẹp storage của mình và không emit socket
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('createConversationMessage — Attachment Batch Limits (Checkpoint 8)', () => {
    const userId = 'user-test-uuid-1';
    const conversationId = 'conv-test-uuid-1';

    beforeEach(() => {
      mockConversationsService.verifyMembership.mockResolvedValue(true);
    });

    it('từ chối khi có 3 file hợp lệ (mỗi file <= 10MB) nhưng tổng dung lượng > 30MB', async () => {
      const tenPointOneMb = 10.1 * 1024 * 1024;
      const files: Express.Multer.File[] = [
        {
          fieldname: 'files',
          originalname: 'file1.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: tenPointOneMb,
          buffer: Buffer.from('%PDF-1.4 test header'),
        } as Express.Multer.File,
        {
          fieldname: 'files',
          originalname: 'file2.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: tenPointOneMb,
          buffer: Buffer.from('%PDF-1.4 test header'),
        } as Express.Multer.File,
        {
          fieldname: 'files',
          originalname: 'file3.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: tenPointOneMb,
          buffer: Buffer.from('%PDF-1.4 test header'),
        } as Express.Multer.File,
      ];

      await expect(
        service.createConversationMessage(
          userId,
          conversationId,
          { content: 'Test batch > 30MB' },
          files,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Tổng dung lượng các tệp đính kèm vượt quá giới hạn 30MB.',
        ),
      );

      // Không upload Storage, không insert database
      expect(mockSupabase.client.from).not.toHaveBeenCalledWith('messages');
      expect(mockSupabase.client.from).not.toHaveBeenCalledWith('attachments');
    });

    it('chấp nhận và vượt qua kiểm tra tổng dung lượng khi batch đạt đúng boundary 30MB (3 x 10MB)', async () => {
      const tenMb = 10 * 1024 * 1024;
      const files: Express.Multer.File[] = [
        {
          fieldname: 'files',
          originalname: 'file1.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: tenMb,
          buffer: Buffer.from('%PDF-1.4 test header'),
        } as Express.Multer.File,
        {
          fieldname: 'files',
          originalname: 'file2.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: tenMb,
          buffer: Buffer.from('%PDF-1.4 test header'),
        } as Express.Multer.File,
        {
          fieldname: 'files',
          originalname: 'file3.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: tenMb,
          buffer: Buffer.from('%PDF-1.4 test header'),
        } as Express.Multer.File,
      ];

      // Giả lập storage upload & database insert
      const storageUploadMock = jest.fn().mockResolvedValue({ error: null });
      const storageSignedUrlMock = jest
        .fn()
        .mockResolvedValue({
          data: { signedUrl: 'https://storage/signed' },
          error: null,
        });

      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          upload: storageUploadMock,
          createSignedUrl: storageSignedUrlMock,
        }),
      } as any;

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            const handler: any = {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest
                .fn()
                .mockResolvedValue({ data: null, error: null }),
              insert: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: '1001',
                      channel_id: null,
                      conversation_id: conversationId,
                      author_id: userId,
                      type: 'default',
                      content: 'Test 30MB boundary',
                      reply_to_id: null,
                      client_nonce: 'nonce-30mb',
                      edited_at: null,
                      deleted_at: null,
                      created_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            };
            return handler;
          }
          if (table === 'attachments') {
            const rows = files.map((f, idx) => ({
              id: `att-${idx + 1}`,
              message_id: '1001',
              storage_path: `conv/${conversationId}/file_${idx}.pdf`,
              filename: f.originalname,
              mime_type: f.mimetype,
              size_bytes: f.size,
              width: null,
              height: null,
              created_at: new Date().toISOString(),
            }));
            return {
              insert: jest.fn().mockReturnValue({
                select: jest.fn().mockResolvedValue({
                  data: rows,
                  error: null,
                }),
              }),
              select: jest.fn().mockReturnValue({
                in: jest.fn().mockResolvedValue({
                  data: rows,
                  error: null,
                }),
              }),
            };
          }
          if (table === 'profiles') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: { id: userId, username: 'minhtai' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      const res = await service.createConversationMessage(
        userId,
        conversationId,
        { content: 'Test 30MB boundary', clientNonce: 'nonce-30mb' },
        files,
      );

      expect(res.id).toBe('1001');
      expect(res.attachments).toHaveLength(3);
      expect(storageUploadMock).toHaveBeenCalledTimes(3);
    });

    it('chấp nhận upload tài liệu DOCX hợp lệ với tên tiếng Việt có dấu', async () => {
      const { createMockZipBuffer } = require('./utils/docx-validator.util');
      const docxBuf = createMockZipBuffer([
        { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
        { name: 'word/document.xml', content: '<w:document></w:document>' },
      ]);

      const files: Express.Multer.File[] = [
        {
          fieldname: 'files',
          originalname: 'Báo cáo Đồ án tốt nghiệp 2026.docx',
          encoding: '7bit',
          mimetype:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: docxBuf.length,
          buffer: docxBuf,
        } as Express.Multer.File,
      ];

      const storageUploadMock = jest.fn().mockResolvedValue({ error: null });
      const storageSignedUrlMock = jest
        .fn()
        .mockResolvedValue({
          data: { signedUrl: 'https://storage/signed-docx' },
          error: null,
        });

      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          upload: storageUploadMock,
          createSignedUrl: storageSignedUrlMock,
        }),
      } as any;

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest
                .fn()
                .mockResolvedValue({ data: null, error: null }),
              insert: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({
                    data: {
                      id: '1002',
                      channel_id: null,
                      conversation_id: conversationId,
                      author_id: userId,
                      type: 'default',
                      content: 'Đính kèm docx',
                      reply_to_id: null,
                      client_nonce: 'nonce-docx',
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
            const rows = [
              {
                id: 'att-docx-1',
                message_id: '1002',
                storage_path: `conv/${conversationId}/file_docx.docx`,
                filename: 'Báo cáo Đồ án tốt nghiệp 2026.docx',
                mime_type:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                size_bytes: docxBuf.length,
                width: null,
                height: null,
                created_at: new Date().toISOString(),
              },
            ];
            return {
              insert: jest.fn().mockReturnValue({
                select: jest.fn().mockResolvedValue({
                  data: rows,
                  error: null,
                }),
              }),
              select: jest.fn().mockReturnValue({
                in: jest.fn().mockResolvedValue({
                  data: rows,
                  error: null,
                }),
              }),
            };
          }
          if (table === 'profiles') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: { id: userId, username: 'minhtai' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      const res = await service.createConversationMessage(
        userId,
        conversationId,
        { content: 'Đính kèm docx', clientNonce: 'nonce-docx' },
        files,
      );

      expect(res.id).toBe('1002');
      expect(res.attachments).toHaveLength(1);
      expect(res.attachments?.[0].filename).toBe(
        'Báo cáo Đồ án tốt nghiệp 2026.docx',
      );
    });

    it('từ chối khi tệp DOCX giả mạo (thiếu word/document.xml)', async () => {
      const { createMockZipBuffer } = require('./utils/docx-validator.util');
      const fakeDocxBuf = createMockZipBuffer([
        { name: '[Content_Types].xml', content: '<?xml version="1.0"?>' },
        { name: 'random.txt', content: 'not docx' },
      ]);

      const files: Express.Multer.File[] = [
        {
          fieldname: 'files',
          originalname: 'Tài liệu giả.docx',
          encoding: '7bit',
          mimetype:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: fakeDocxBuf.length,
          buffer: fakeDocxBuf,
        } as Express.Multer.File,
      ];

      await expect(
        service.createConversationMessage(
          userId,
          conversationId,
          { content: 'Test fake docx' },
          files,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('getAttachmentSignedUrl gọi createSignedUrl với tùy chọn { download: filename }', async () => {
      const createSignedUrlMock = jest.fn().mockResolvedValue({
        data: { signedUrl: 'https://storage/signed-download' },
        error: null,
      });

      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          createSignedUrl: createSignedUrlMock,
        }),
      } as any;

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'attachments') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: {
                      id: 'att-123',
                      storage_path: 'conv/conv-test-uuid-1/tailieu.docx',
                      filename: 'Tài liệu tiếng Việt.docx',
                      message_id: '1001',
                      messages: {
                        conversation_id: conversationId,
                        deleted_at: null,
                      },
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      const res = await service.getAttachmentSignedUrl(
        userId,
        conversationId,
        'att-123',
      );

      expect(res.signedUrl).toBe('https://storage/signed-download');
      expect(createSignedUrlMock).toHaveBeenCalledWith(
        'conv/conv-test-uuid-1/tailieu.docx',
        3600,
        { download: 'Tài liệu tiếng Việt.docx' },
      );
    });
  });

  describe('createChannelMessage — Concurrency, DOCX & Deduplication Tests (Checkpoint 12 Blockers 1, 2, 4)', () => {
    const channelId = 'chan-test-1111-2222';
    const serverId = 'srv-test-1111-2222';
    const userId = 'usr-test-1111-2222';

    beforeEach(() => {
      jest.clearAllMocks();
      mockServerPermissionsService.assertChannelSend = jest
        .fn()
        .mockResolvedValue(undefined);
      mockServerPermissionsService.assertChannelAttach = jest
        .fn()
        .mockResolvedValue(undefined);
    });

    it('Blocker 1 & 4: Deferred Barrier Concurrency: Hai request overlapping cùng clientNonce -> cả hai hoàn thành pre-check và upload Storage trước khi barrier mở -> request thắng tạo message, request thua bắt 23505 dọn storage và không emit duplicate', async () => {
      const clientNonce = 'nonce-overlap-concurrent-123';
      const file1: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'doc1.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 1024,
        buffer: Buffer.from('%PDF-1.4 test document 1'),
      } as Express.Multer.File;

      const file2: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'doc2.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 2048,
        buffer: Buffer.from('%PDF-1.4 test document 2'),
      } as Express.Multer.File;

      // Deferred Barrier đồng bộ hóa: Cả 2 request phải đến điểm RPC trước khi barrier mở
      class DeferredBarrier {
        private count = 0;
        private target: number;
        private reachedResolve!: () => void;
        readonly reached: Promise<void>;
        private proceedResolve!: () => void;
        readonly proceed: Promise<void>;

        constructor(target: number) {
          this.target = target;
          this.reached = new Promise((r) => {
            this.reachedResolve = r;
          });
          this.proceed = new Promise((r) => {
            this.proceedResolve = r;
          });
        }

        async waitToProceed(): Promise<void> {
          this.count++;
          if (this.count >= this.target) {
            this.reachedResolve();
          }
          await this.proceed;
        }

        release(): void {
          this.proceedResolve();
        }
      }

      const barrier = new DeferredBarrier(2);
      const uploadedPaths: string[] = [];
      const removedPaths: string[][] = [];

      const uploadMock = jest.fn().mockImplementation((storagePath: string) => {
        uploadedPaths.push(storagePath);
        return Promise.resolve({ data: { path: storagePath }, error: null });
      });

      const removeMock = jest.fn().mockImplementation((paths: string[]) => {
        removedPaths.push(paths);
        return Promise.resolve({ data: paths, error: null });
      });

      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          upload: uploadMock,
          remove: removeMock,
          createSignedUrls: jest
            .fn()
            .mockResolvedValue({ data: [], error: null }),
        }),
      } as any;

      const rpcArrivalOrder: string[] = [];
      mockSupabase.client.rpc = jest
        .fn()
        .mockImplementation(async (rpcName: string, params: any) => {
          if (rpcName === 'create_channel_message') {
            // RPC đọc khoá camelCase (`v_att_elem->>'storagePath'`), nên payload cũng
            // phải là camelCase. Mock đọc `storage_path` thì cả hai request cùng nhận
            // chuỗi rỗng, hoà nhau ở bước chọn winner và không ai bị 23505.
            const reqAttachmentPath =
              params?.p_attachments?.[0]?.storagePath || '';
            rpcArrivalOrder.push(reqAttachmentPath);

            // CẢ HAI REQUEST DỪNG LẠI TẠI BARRIER (chờ cả hai cùng upload storage xong và đến điểm RPC)
            await barrier.waitToProceed();

            // Khi barrier được mở: Request đầu tiên đến barrier là winner, request thứ hai là loser (23505)
            if (rpcArrivalOrder[0] === reqAttachmentPath) {
              return {
                data: {
                  id: '2001',
                  channelId,
                  authorId: userId,
                  content: 'Concurrent test message',
                  isForwarded: false,
                  replyToId: null,
                  clientNonce,
                  createdAt: new Date().toISOString(),
                },
                error: null,
              };
            } else {
              return {
                data: null,
                error: { code: '23505', message: 'Client nonce đã tồn tại' },
              };
            }
          }
          return { data: null, error: null };
        });

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    maybeSingle: jest.fn().mockImplementation(() => {
                      // Pre-check trả về null trước khi RPC xử lý
                      if (uploadedPaths.length < 2) {
                        return Promise.resolve({ data: null, error: null });
                      }
                      // Canonical lookup sau khi bắt 23505:
                      return Promise.resolve({
                        data: {
                          id: '2001',
                          channel_id: channelId,
                          conversation_id: null,
                          author_id: userId,
                          type: 'default',
                          content: 'Concurrent test message',
                          is_forwarded: false,
                          reply_to_id: null,
                          client_nonce: clientNonce,
                          edited_at: null,
                          deleted_at: null,
                          created_at: new Date().toISOString(),
                        },
                        error: null,
                      });
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'profiles') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: {
                      id: userId,
                      username: 'testuser',
                      display_name: 'Test User',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'attachments') {
            return {
              select: jest.fn().mockReturnValue({
                in: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      // Bắt đầu cả 2 request đồng thời
      const p1 = service.createChannelMessage(
        userId,
        channelId,
        { content: 'Concurrent test message', clientNonce },
        [file1],
      );
      const p2 = service.createChannelMessage(
        userId,
        channelId,
        { content: 'Concurrent test message', clientNonce },
        [file2],
      );

      // Chờ cho đến khi CẢ HAI request đã hoàn thành pre-check và upload Storage, chạm tới barrier
      await barrier.reached;

      // 1. Xác minh: Cả 2 request đều ĐÃ upload Storage thành công trước khi RPC xử lý
      expect(uploadedPaths).toHaveLength(2);
      expect(uploadedPaths[0]).not.toEqual(uploadedPaths[1]); // 2 storage paths khác nhau

      // Mở barrier để cho cả hai RPC tiếp tục
      barrier.release();

      const [res1, res2] = await Promise.all([p1, p2]);

      // Cả 2 request đều trả về cùng canonical message ID
      expect(res1.id).toBe('2001');
      expect(res2.id).toBe('2001');

      // 2. Chỉ storage path của request thua cuộc bị dọn dẹp
      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(removedPaths).toHaveLength(1);
      expect(removedPaths[0]).toEqual([uploadedPaths[1]]);

      // Storage path của request thắng không bị xóa
      expect(removedPaths[0]).not.toContain(uploadedPaths[0]);

      // 3. Socket event CHAT_EVENTS.MESSAGE_CREATED chỉ emit ĐÚNG 1 LẦN (không duplicate)
      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CHAT_EVENTS.MESSAGE_CREATED,
        expect.objectContaining({
          channelId,
          message: expect.objectContaining({ id: '2001' }),
        }),
      );
    });

    it('Blocker 1: Duplicate clientNonce cho channel khác ném ConflictException (409) và vẫn dọn dẹp storage của request', async () => {
      const clientNonce = 'nonce-diff-channel-999';
      const file: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'doc.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 512,
        buffer: Buffer.from('%PDF-1.4 test document'),
      } as Express.Multer.File;

      const uploadedPaths: string[] = [];
      const removedPaths: string[][] = [];

      const uploadMock = jest.fn().mockImplementation((storagePath: string) => {
        uploadedPaths.push(storagePath);
        return Promise.resolve({ data: { path: storagePath }, error: null });
      });

      const removeMock = jest.fn().mockImplementation((paths: string[]) => {
        removedPaths.push(paths);
        return Promise.resolve({ data: paths, error: null });
      });

      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          upload: uploadMock,
          remove: removeMock,
        }),
      } as any;

      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'Client nonce đã tồn tại' },
      });

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    maybeSingle: jest
                      .fn()
                      .mockResolvedValueOnce({ data: null, error: null }) // Pre-check
                      .mockResolvedValueOnce({
                        // Canonical lookup: thuộc channel khác 'other-channel-999'
                        data: {
                          id: '8888',
                          channel_id: 'other-channel-999',
                          conversation_id: null,
                          author_id: userId,
                          client_nonce: clientNonce,
                        },
                        error: null,
                      }),
                  }),
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      await expect(
        service.createChannelMessage(
          userId,
          channelId,
          { content: 'Conflict channel', clientNonce },
          [file],
        ),
      ).rejects.toThrow(ConflictException);

      // Storage files của request thất bại phải được dọn dẹp
      expect(uploadedPaths).toHaveLength(1);
      expect(removeMock).toHaveBeenCalledTimes(1);
      expect(removedPaths[0]).toEqual(uploadedPaths);
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('Blocker 2: Gửi tin nhắn kênh đính kèm tệp DOCX hợp lệ thành công', async () => {
      const { createMockZipBuffer } = require('./utils/docx-validator.util');
      const validDocxBuf = createMockZipBuffer([
        {
          name: '[Content_Types].xml',
          content:
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
        },
        {
          name: 'word/document.xml',
          content:
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>',
        },
      ]);

      const docxFile: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'Kế Hoạch Dự Án.docx',
        encoding: '7bit',
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: validDocxBuf.length,
        buffer: validDocxBuf,
      } as Express.Multer.File;

      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          upload: jest
            .fn()
            .mockResolvedValue({
              data: { path: 'channels/chan-test-1111-2222/file-uuid.docx' },
              error: null,
            }),
          createSignedUrls: jest.fn().mockResolvedValue({
            data: [
              {
                path: 'channels/chan-test-1111-2222/file-uuid.docx',
                signedUrl: 'https://storage/signed-docx',
              },
            ],
            error: null,
          }),
        }),
      } as any;

      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: {
          id: '3001',
          channelId,
          authorId: userId,
          content: 'Tài liệu Word',
          isForwarded: false,
          replyToId: null,
          clientNonce: 'nonce-docx-channel',
          createdAt: new Date().toISOString(),
        },
        error: null,
      });

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    maybeSingle: jest
                      .fn()
                      .mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'profiles') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  maybeSingle: jest.fn().mockResolvedValue({
                    data: { id: userId, username: 'docx_user' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'attachments') {
            return {
              select: jest.fn().mockReturnValue({
                in: jest.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'att-docx-1',
                      message_id: '3001',
                      storage_path:
                        'channels/chan-test-1111-2222/file-uuid.docx',
                      filename: 'Kế Hoạch Dự Án.docx',
                      mime_type:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      size_bytes: validDocxBuf.length,
                      width: null,
                      height: null,
                      created_at: new Date().toISOString(),
                    },
                  ],
                  error: null,
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      const res = await service.createChannelMessage(
        userId,
        channelId,
        { content: 'Tài liệu Word', clientNonce: 'nonce-docx-channel' },
        [docxFile],
      );

      expect(res.id).toBe('3001');
      expect(res.attachments).toHaveLength(1);
      expect(res.attachments?.[0].filename).toBe('Kế Hoạch Dự Án.docx');
      expect(res.attachments?.[0].mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    });

    it('Blocker 2: Khi RPC create_channel_message từ chối attachment (ví dụ 22023), Storage objects của request được cleanup ngay lập tức', async () => {
      const file: Express.Multer.File = {
        fieldname: 'files',
        originalname: 'test.pdf',
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: 1024,
        buffer: Buffer.from('%PDF-1.4 test document'),
      } as Express.Multer.File;

      const removeMock = jest.fn().mockResolvedValue({ data: [], error: null });
      mockSupabase.client.storage = {
        from: jest.fn().mockReturnValue({
          upload: jest
            .fn()
            .mockResolvedValue({ data: { path: 'uploaded' }, error: null }),
          remove: removeMock,
        }),
      } as any;

      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: null,
        error: {
          code: '22023',
          message: 'Loại tệp không nằm trong danh sách cho phép',
        },
      });

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  eq: jest.fn().mockReturnValue({
                    maybeSingle: jest
                      .fn()
                      .mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      await expect(
        service.createChannelMessage(
          userId,
          channelId,
          { content: 'Bad attachment' },
          [file],
        ),
      ).rejects.toThrow(BadRequestException);

      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it('Permission: Người dùng thiếu quyền SEND_MESSAGES khi gửi GIF nhận 403 Forbidden', async () => {
      mockServerPermissionsService.assertChannelSend.mockRejectedValueOnce(
        new ForbiddenException(
          'Bạn không có quyền gửi tin nhắn trong kênh này.',
        ),
      );

      const gifDto = {
        provider: 'giphy' as const,
        externalId: 'abc12345',
        mediaType: 'gif' as const,
        title: 'Dancing Dog',
        creatorUsername: 'giphyartist',
        pageUrl: 'https://giphy.com/gifs/dog-abc12345',
        previewUrl: 'https://media.giphy.com/media/abc12345/200w.webp',
        displayUrl: 'https://media.giphy.com/media/abc12345/giphy.gif',
        mp4Url: 'https://media.giphy.com/media/abc12345/giphy.mp4',
        width: 480,
        height: 360,
      };

      await expect(
        service.createChannelMessage(userId, channelId, {
          content: '',
          externalMedia: gifDto,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(
        mockServerPermissionsService.assertChannelSend,
      ).toHaveBeenCalledWith(userId, channelId);
      expect(
        mockServerPermissionsService.assertChannelAttach,
      ).not.toHaveBeenCalled();
    });

    it('Permission: Gửi GIF chỉ yêu cầu SEND_MESSAGES và KHÔNG gọi assertChannelAttach', async () => {
      mockServerPermissionsService.assertChannelSend.mockResolvedValueOnce(
        undefined,
      );

      const gifDto = {
        provider: 'giphy' as const,
        externalId: 'abc12345',
        mediaType: 'gif' as const,
        title: 'Dancing Dog',
        creatorUsername: 'giphyartist',
        pageUrl: 'https://giphy.com/gifs/dog-abc12345',
        previewUrl: 'https://media.giphy.com/media/abc12345/200w.webp',
        displayUrl: 'https://media.giphy.com/media/abc12345/giphy.gif',
        mp4Url: 'https://media.giphy.com/media/abc12345/giphy.mp4',
        width: 480,
        height: 360,
      };

      mockSupabase.client.rpc = jest.fn().mockResolvedValue({
        data: {
          id: '5001',
          channelId,
          authorId: userId,
          type: 'default',
          content: null,
          isForwarded: false,
          replyToId: null,
          clientNonce: 'nonce-gif-perm',
          createdAt: new Date().toISOString(),
          attachments: [],
          externalMedia: gifDto,
        },
        error: null,
      });

      const res = await service.createChannelMessage(userId, channelId, {
        content: '',
        clientNonce: 'nonce-gif-perm',
        externalMedia: gifDto,
      });

      expect(res.id).toBe('5001');
      expect(res.externalMedia?.externalId).toBe('abc12345');
      expect(
        mockServerPermissionsService.assertChannelSend,
      ).toHaveBeenCalledWith(userId, channelId);
      expect(
        mockServerPermissionsService.assertChannelAttach,
      ).not.toHaveBeenCalled();
    });

    it('Canonical: getChannelMessages load đúng externalMedia từ bảng message_external_media', async () => {
      const mockMsg = {
        id: '6001',
        channel_id: channelId,
        conversation_id: null,
        author_id: userId,
        type: 'default',
        content: null,
        is_forwarded: false,
        reply_to_id: null,
        client_nonce: 'nonce-ext-1',
        edited_at: null,
        deleted_at: null,
        created_at: '2026-08-25T10:00:00Z',
      };

      mockSupabase.client.from = jest
        .fn()
        .mockImplementation((table: string) => {
          if (table === 'messages') {
            return {
              select: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  order: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue({
                      data: [mockMsg],
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'message_external_media') {
            return {
              select: jest.fn().mockReturnValue({
                in: jest.fn().mockResolvedValue({
                  data: [
                    {
                      message_id: '6001',
                      provider: 'giphy',
                      external_id: 'gif-6001',
                      media_type: 'gif',
                      title: 'Trending GIF',
                      creator_username: 'giphy',
                      page_url: 'https://giphy.com/gifs/gif-6001',
                      preview_url:
                        'https://media.giphy.com/media/gif-6001/200w.webp',
                      display_url:
                        'https://media.giphy.com/media/gif-6001/giphy.gif',
                      mp4_url:
                        'https://media.giphy.com/media/gif-6001/giphy.mp4',
                      width: 400,
                      height: 300,
                    },
                  ],
                  error: null,
                }),
              }),
            };
          }
          return defaultTableHandler(table);
        });

      const res = await service.getChannelMessages(userId, channelId, {
        limit: 50,
      });
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].externalMedia).toBeDefined();
      expect(res.messages[0].externalMedia?.externalId).toBe('gif-6001');
      expect(res.messages[0].externalMedia?.width).toBe(400);
    });

    it('Idempotency: Hai cuộc gọi concurrent cùng clientNonce đều thành công, trả về cùng canonical ID và chỉ emit đúng 1 realtime message:created', async () => {
      mockServerPermissionsService.assertChannelSend.mockResolvedValue(
        undefined,
      );
      const emitSpy = jest.spyOn((service as any).eventEmitter, 'emit');

      const gifDto = {
        provider: 'giphy' as const,
        externalId: 'conc-gif-1',
        mediaType: 'gif' as const,
        title: 'Concurrent GIF',
        creatorUsername: 'artist',
        pageUrl: 'https://giphy.com/gifs/conc-gif-1',
        previewUrl: 'https://media.giphy.com/media/conc-gif-1/200w.webp',
        displayUrl: 'https://media.giphy.com/media/conc-gif-1/giphy.gif',
        mp4Url: 'https://media.giphy.com/media/conc-gif-1/giphy.mp4',
        width: 480,
        height: 360,
      };

      // Giả lập Winner (call 1: isDuplicate = false) và Loser (call 2: isDuplicate = true)
      mockSupabase.client.rpc
        .mockResolvedValueOnce({
          data: {
            id: '7001',
            channelId,
            authorId: userId,
            type: 'default',
            content: '',
            isForwarded: false,
            replyToId: null,
            clientNonce: 'conc-nonce-99',
            createdAt: '2026-08-25T12:00:00Z',
            attachments: [],
            externalMedia: gifDto,
            isDuplicate: false,
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            id: '7001',
            channelId,
            authorId: userId,
            type: 'default',
            content: '',
            isForwarded: false,
            replyToId: null,
            clientNonce: 'conc-nonce-99',
            createdAt: '2026-08-25T12:00:00Z',
            attachments: [],
            externalMedia: gifDto,
            isDuplicate: true,
          },
          error: null,
        });

      const [call1, call2] = await Promise.all([
        service.createChannelMessage(userId, channelId, {
          content: '',
          clientNonce: 'conc-nonce-99',
          externalMedia: gifDto,
        }),
        service.createChannelMessage(userId, channelId, {
          content: '',
          clientNonce: 'conc-nonce-99',
          externalMedia: gifDto,
        }),
      ]);

      // Cả hai HTTP call đều thành công
      expect(call1.id).toBe('7001');
      expect(call2.id).toBe('7001');
      expect(call1.externalMedia?.externalId).toBe('conc-gif-1');
      expect(call2.externalMedia?.externalId).toBe('conc-gif-1');

      // CHỈ emit đúng 1 sự kiện realtime message:created (cho winner, bỏ qua duplicate loser)
      const messageCreatedCalls = emitSpy.mock.calls.filter(
        (c: any[]) => c[0] === CHAT_EVENTS.MESSAGE_CREATED,
      );
      expect(messageCreatedCalls).toHaveLength(1);
    });
  });
});
