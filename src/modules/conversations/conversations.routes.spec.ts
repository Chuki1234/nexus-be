import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { MessagesController } from '../messages/messages.controller';
import { MessagesService } from '../messages/messages.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

describe('Conversations & Messages Route Prefix Contract Tests (HTTP Level)', () => {
  let app: INestApplication;

  const mockUser = {
    id: 'a0000000-0000-0000-0000-000000000001',
    email: 'test@nexuscord.internal',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };

  const mockConversationsService = {
    getOrCreateDm: jest.fn().mockResolvedValue({
      id: 'c0000000-0000-0000-0000-000000000001',
      type: 'dm',
    }),
    listConversations: jest.fn().mockResolvedValue([]),
    getConversationById: jest.fn().mockResolvedValue({
      id: 'c0000000-0000-0000-0000-000000000001',
      type: 'dm',
    }),
  };

  const mockMessagesService = {
    getConversationMessages: jest.fn().mockResolvedValue({
      messages: [],
      hasMore: false,
    }),
    createConversationMessage: jest.fn().mockResolvedValue({
      id: 'm0000000-0000-0000-0000-000000000001',
      content: 'hello',
    }),
    editMessage: jest.fn().mockResolvedValue({
      id: '101',
      content: 'edited',
    }),
    deleteMessage: jest.fn().mockResolvedValue({
      id: '101',
      deleted: true,
    }),
    getAttachmentSignedUrl: jest.fn().mockResolvedValue({
      signedUrl: 'https://storage.supabase.co/signed/sample.png',
    }),
    markAsRead: jest.fn().mockResolvedValue({
      success: true,
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ConversationsController, MessagesController],
      providers: [
        {
          provide: ConversationsService,
          useValue: mockConversationsService,
        },
        {
          provide: MessagesService,
          useValue: mockMessagesService,
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          req.user = mockUser;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // Bắt buộc cấu hình global prefix 'api' hệt như trong main.ts
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Conversations Routes Contract', () => {
    it('POST /api/conversations/dm tồn tại và trả 201/200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/conversations/dm')
        .send({ recipientId: 'b0000000-0000-4000-8000-000000000002' });

      expect(res.status).toBe(201);
      expect(mockConversationsService.getOrCreateDm).toHaveBeenCalledWith(
        mockUser.id,
        'b0000000-0000-4000-8000-000000000002',
      );
    });

    it('POST /api/api/conversations/dm trả 404 (chứng minh không bị double prefix /api/api)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/api/conversations/dm')
        .send({ recipientId: 'b0000000-0000-4000-8000-000000000002' });

      expect(res.status).toBe(404);
    });

    it('GET /api/conversations tồn tại và trả 200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer()).get('/api/conversations');
      expect(res.status).toBe(200);
      expect(mockConversationsService.listConversations).toHaveBeenCalledWith(mockUser.id);
    });

    it('GET /api/conversations/:id tồn tại và trả 200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/conversations/c0000000-0000-4000-8000-000000000001',
      );
      expect(res.status).toBe(200);
      expect(mockConversationsService.getConversationById).toHaveBeenCalledWith(
        mockUser.id,
        'c0000000-0000-4000-8000-000000000001',
      );
    });
  });

  describe('2. Messages & Attachments Routes Contract', () => {
    it('GET /api/conversations/:id/messages tồn tại và trả 200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/conversations/c0000000-0000-4000-8000-000000000001/messages',
      );
      expect(res.status).toBe(200);
      expect(mockMessagesService.getConversationMessages).toHaveBeenCalled();
    });

    it('POST /api/conversations/:id/messages tồn tại và trả 201/200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/conversations/c0000000-0000-4000-8000-000000000001/messages')
        .send({ content: 'Hello Route Test' });

      expect(res.status).toBe(201);
      expect(mockMessagesService.createConversationMessage).toHaveBeenCalled();
    });

    it('POST /api/conversations/:id/read tồn tại và trả 201/200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/conversations/c0000000-0000-4000-8000-000000000001/read')
        .send({ messageId: '101' });

      expect(res.status).toBe(201);
      expect(mockMessagesService.markAsRead).toHaveBeenCalled();
    });

    it('GET /api/conversations/:id/attachments/:attId/signed-url tồn tại và trả 200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/conversations/c0000000-0000-4000-8000-000000000001/attachments/d0000000-0000-4000-8000-000000000001/signed-url',
      );
      expect(res.status).toBe(200);
      expect(mockMessagesService.getAttachmentSignedUrl).toHaveBeenCalled();
      expect(res.body.signedUrl).toBe('https://storage.supabase.co/signed/sample.png');
    });

    it('PATCH /api/messages/:id tồn tại và trả 200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/messages/101')
        .send({ content: 'Updated content' });

      expect(res.status).toBe(200);
      expect(mockMessagesService.editMessage).toHaveBeenCalled();
    });

    it('DELETE /api/messages/:id tồn tại và trả 200 (không trả 404)', async () => {
      const res = await request(app.getHttpServer()).delete('/api/messages/101');
      expect(res.status).toBe(200);
      expect(mockMessagesService.deleteMessage).toHaveBeenCalled();
    });

    it('Các đường dẫn /api/api/... đều trả 404', async () => {
      const resMsg = await request(app.getHttpServer()).get(
        '/api/api/conversations/c0000000-0000-4000-8000-000000000001/messages',
      );
      expect(resMsg.status).toBe(404);

      const resRead = await request(app.getHttpServer())
        .post('/api/api/conversations/c0000000-0000-4000-8000-000000000001/read')
        .send({ messageId: '101' });
      expect(resRead.status).toBe(404);

      const resSigned = await request(app.getHttpServer()).get(
        '/api/api/conversations/c0000000-0000-4000-8000-000000000001/attachments/d0000000-0000-4000-8000-000000000001/signed-url',
      );
      expect(resSigned.status).toBe(404);

      const resPatch = await request(app.getHttpServer())
        .patch('/api/api/messages/101')
        .send({ content: 'test' });
      expect(resPatch.status).toBe(404);
    });
  });
});
