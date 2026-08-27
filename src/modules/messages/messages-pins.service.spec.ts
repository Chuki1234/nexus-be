import { ForbiddenException } from '@nestjs/common';
import { CHAT_EVENTS } from '../realtime/constants/chat-events.constant';
import { MessagesService } from './messages.service';

describe('MessagesService message pins', () => {
  const userId = '10000000-0000-4000-8000-000000000001';
  const conversationId = '20000000-0000-4000-8000-000000000002';
  const channelId = '30000000-0000-4000-8000-000000000003';
  const messageId = '9007199254740999999';

  let rpc: jest.Mock;
  let emit: jest.Mock;
  let service: MessagesService;

  beforeEach(() => {
    rpc = jest.fn();
    emit = jest.fn();
    service = new MessagesService(
      { client: { rpc } } as never,
      {} as never,
      {} as never,
      { emit } as never,
    );

    (jest
      .spyOn(service as any, 'assembleMessageDtos') as any)
      .mockImplementation(async (rows: any[]) =>
        rows.map((row) => ({
          id: String(row.id),
          channelId: row.channel_id ?? null,
          conversationId: row.conversation_id ?? null,
          pinnedAt: row.pinned_at ?? null,
        })),
      );
  });

  it('lấy ghim DM qua RPC có kiểm tra user trong database', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ id: messageId, conversation_id: conversationId }],
      error: null,
    });

    const result = await service.getConversationPinnedMessages(
      conversationId,
      userId,
    );

    expect(rpc).toHaveBeenCalledWith('get_conversation_pinned_messages', {
      p_conversation_id: conversationId,
      p_user_id: userId,
    });
    expect(result[0]).toEqual(
      expect.objectContaining({ id: messageId, conversationId }),
    );
  });

  it('giữ message bigint dưới dạng string và phát realtime đúng conversation room', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          id: messageId,
          channel_id: null,
          conversation_id: conversationId,
          pinned_at: '2026-08-27T05:00:00Z',
        },
      ],
      error: null,
    });

    await service.setMessagePin(messageId, userId, true);

    expect(rpc).toHaveBeenCalledWith('set_message_pin', {
      p_message_id: messageId,
      p_user_id: userId,
      p_pinned: true,
    });
    expect(emit).toHaveBeenCalledWith(
      CHAT_EVENTS.MESSAGE_PIN_UPDATED,
      expect.objectContaining({
        channelId: null,
        conversationId,
        pinned: true,
      }),
    );
  });

  it('phát realtime đúng channel room và ánh xạ lỗi quyền', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ id: '101', channel_id: channelId, conversation_id: null }],
      error: null,
    });
    await service.setMessagePin('101', userId, false);
    expect(emit).toHaveBeenCalledWith(
      CHAT_EVENTS.MESSAGE_PIN_UPDATED,
      expect.objectContaining({
        channelId,
        conversationId: null,
        pinned: false,
      }),
    );

    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    await expect(
      service.setMessagePin('101', userId, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
