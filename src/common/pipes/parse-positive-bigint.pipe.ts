import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

/**
 * Pipe kiểm tra chuỗi message ID là số nguyên dương hợp lệ (PostgreSQL BIGINT > 0).
 */
@Injectable()
export class ParsePositiveBigIntPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!value || typeof value !== 'string') {
      throw new BadRequestException(
        'messageId phải là chuỗi số nguyên dương (bigint).',
      );
    }
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new BadRequestException(
        'messageId phải là chuỗi số nguyên dương (bigint).',
      );
    }
    return trimmed;
  }
}
