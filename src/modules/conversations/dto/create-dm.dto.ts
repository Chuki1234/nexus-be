import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateDmDto {
  @IsUUID('4', { message: 'recipientId phải là UUID hợp lệ' })
  @IsNotEmpty({ message: 'recipientId không được để trống' })
  recipientId: string;
}
