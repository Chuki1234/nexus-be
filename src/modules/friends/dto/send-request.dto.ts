import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import { USERNAME_PATTERN } from '../../../shared/dto/auth';

export class SendRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString({ message: 'Tên người dùng phải là chuỗi.' })
  @Length(3, 32, { message: 'Tên người dùng phải từ 3 đến 32 ký tự.' })
  @Matches(USERNAME_PATTERN, {
    message: 'Tên người dùng chỉ gồm chữ thường, số, dấu gạch dưới hoặc dấu chấm.',
  })
  username!: string;
}
