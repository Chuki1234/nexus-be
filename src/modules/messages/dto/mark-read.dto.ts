import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class MarkReadDto {
  @IsNotEmpty({ message: 'messageId không được để trống.' })
  @IsString({ message: 'messageId phải là chuỗi ký tự.' })
  @Matches(/^[1-9]\d*$/, {
    message: 'messageId phải là chuỗi số nguyên dương (bigint).',
  })
  messageId!: string;
}
