import { Test, TestingModule } from '@nestjs/testing';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { DirectCallsController } from './direct-calls.controller';
import { DirectCallsService } from './direct-calls.service';

describe('DirectCallsController', () => {
  let controller: DirectCallsController;
  let mockService: any;

  beforeEach(async () => {
    mockService = {
      startCall: jest.fn(),
      getActiveCall: jest.fn(),
      getCallHistory: jest.fn(),
      answerCall: jest.fn(),
      declineCall: jest.fn(),
      cancelCall: jest.fn(),
      endCall: jest.fn(),
      getToken: jest.fn(),
      handleWebhook: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DirectCallsController],
      providers: [{ provide: DirectCallsService, useValue: mockService }],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DirectCallsController>(DirectCallsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call startCall on service', async () => {
    const mockUser: any = { id: 'user-1' };
    const mockDto: any = { conversationId: 'conv-1', initialMode: 'video', clientSessionId: 'sess-1' };
    await controller.startCall(mockUser, mockDto);
    expect(mockService.startCall).toHaveBeenCalledWith('user-1', mockDto);
  });

  it('should call answerCall on service', async () => {
    const mockUser: any = { id: 'user-2' };
    const mockDto: any = { clientSessionId: 'sess-2' };
    await controller.answerCall(mockUser, 'call-1', mockDto);
    expect(mockService.answerCall).toHaveBeenCalledWith('user-2', 'call-1', mockDto);
  });
});
