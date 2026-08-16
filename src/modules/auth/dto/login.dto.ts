import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LoginDto {
  /**
   * Email hoặc tên đăng nhập — một ô duy nhất trên giao diện.
   *
   * Không validate định dạng ở đây: nếu chỉ nhận email hợp lệ thì tên đăng nhập
   * bị chặn, còn nếu tách hai luật thì thông báo lỗi sẽ tiết lộ backend đang coi
   * chuỗi vừa nhập là loại nào.
   */
  @Transform(trim)
  // Thứ tự có ý nghĩa: `stopAtFirstError` (bật ở main.ts) giữ lại lỗi của
  // decorator DƯỚI CÙNG, nên luật cơ bản nhất phải nằm dưới. Xếp ngược lại thì
  // bỏ trống ô mật khẩu sẽ nhận thông báo "Mật khẩu tối đa 72 ký tự."
  @MaxLength(254, { message: 'Email hoặc tên đăng nhập quá dài.' })
  @IsString({ message: 'Vui lòng nhập email hoặc tên đăng nhập.' })
  @MinLength(1, { message: 'Vui lòng nhập email hoặc tên đăng nhập.' })
  identifier: string;

  @MaxLength(72, { message: 'Mật khẩu tối đa 72 ký tự.' })
  @IsString({ message: 'Vui lòng nhập mật khẩu.' })
  @MinLength(1, { message: 'Vui lòng nhập mật khẩu.' })
  password: string;
}
