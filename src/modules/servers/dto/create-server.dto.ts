import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import {
  SERVER_TEMPLATES,
  type ServerTemplateId,
} from '../constants/server-templates.constant';

const VALID_TEMPLATE_IDS = SERVER_TEMPLATES.map((t) => t.id);

export class CreateServerDto {
  @IsString({ message: 'Tên máy chủ phải là chuỗi văn bản.' })
  @IsNotEmpty({ message: 'Tên máy chủ không được để trống.' })
  @MinLength(2, { message: 'Tên máy chủ phải có ít nhất 2 ký tự.' })
  @MaxLength(100, { message: 'Tên máy chủ không được vượt quá 100 ký tự.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name: string;

  @IsString({ message: 'Mẫu máy chủ phải là chuỗi định danh.' })
  @IsNotEmpty({ message: 'Vui lòng chọn một mẫu máy chủ.' })
  @IsIn(VALID_TEMPLATE_IDS, {
    message: 'Mẫu máy chủ không hợp lệ.',
  })
  templateId: ServerTemplateId;
}
