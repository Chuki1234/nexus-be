import { validate } from 'class-validator';
import { EditMessageDto } from './edit-message.dto';
import { SendMessageDto } from './send-message.dto';

describe('Message DTO content length', () => {
  const longContent = 'N'.repeat(20_000);

  it('cho phép gửi nội dung dài hơn 4.000 ký tự', async () => {
    const dto = Object.assign(new SendMessageDto(), { content: longContent });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('cho phép chỉnh sửa nội dung dài hơn 4.000 ký tự', async () => {
    const dto = Object.assign(new EditMessageDto(), { content: longContent });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
