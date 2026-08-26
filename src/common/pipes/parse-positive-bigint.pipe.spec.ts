import { BadRequestException } from '@nestjs/common';
import { ParsePositiveBigIntPipe } from './parse-positive-bigint.pipe';

describe('ParsePositiveBigIntPipe', () => {
  let pipe: ParsePositiveBigIntPipe;

  beforeEach(() => {
    pipe = new ParsePositiveBigIntPipe();
  });

  it('chấp nhận chuỗi số nguyên dương hợp lệ', () => {
    expect(pipe.transform('1')).toBe('1');
    expect(pipe.transform('9007199254740999999')).toBe('9007199254740999999');
    expect(pipe.transform(' 12345 ')).toBe('12345');
  });

  it('ném BadRequestException nếu là 0 hoặc số âm', () => {
    expect(() => pipe.transform('0')).toThrow(BadRequestException);
    expect(() => pipe.transform('-1')).toThrow(BadRequestException);
    expect(() => pipe.transform('-999')).toThrow(BadRequestException);
  });

  it('ném BadRequestException nếu chứa ký tự không phải số hoặc UUID', () => {
    expect(() => pipe.transform('abc')).toThrow(BadRequestException);
    expect(() => pipe.transform('12a34')).toThrow(BadRequestException);
    expect(() => pipe.transform('12.34')).toThrow(BadRequestException);
    expect(() => pipe.transform('a0000000-0000-0000-0000-000000000001')).toThrow(
      BadRequestException,
    );
  });

  it('ném BadRequestException nếu là chuỗi rỗng hoặc null/undefined', () => {
    expect(() => pipe.transform('')).toThrow(BadRequestException);
    expect(() => pipe.transform('   ')).toThrow(BadRequestException);
    expect(() => pipe.transform(null as any)).toThrow(BadRequestException);
    expect(() => pipe.transform(undefined as any)).toThrow(BadRequestException);
  });
});
