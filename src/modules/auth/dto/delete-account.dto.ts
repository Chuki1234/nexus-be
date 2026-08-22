import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

const normalizeEmail = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class DeleteAccountDto {
  @Transform(normalizeEmail)
  @MaxLength(254, { message: 'Email quá dài.' })
  @IsEmail({}, { message: 'Vui lòng nhập email hợp lệ.' })
  @IsString({ message: 'Vui lòng nhập email.' })
  email: string;
}
