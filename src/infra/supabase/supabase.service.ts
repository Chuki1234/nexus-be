import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Sở hữu client Supabase duy nhất của backend.
 *
 * Dùng SERVICE ROLE key: client này bỏ qua toàn bộ Row Level Security và gọi
 * được Admin API. Tuyệt đối không trả key này về frontend, không log nó ra.
 */
@Injectable()
export class SupabaseService {
  // Chưa sinh type `Database` từ Supabase, nên generic mặc định của `createClient`
  // lệch một bậc so với `SupabaseClient` và eslint đọc thành "unsafe assignment".
  // Bỏ chú thích kiểu này đi thì `.from('profiles').insert()` lại suy ra `never[]`.
  // Cách sửa thật: `npx supabase gen types typescript` rồi gắn `SupabaseClient<Database>`.

  readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    const url = config.get<string>('SUPABASE_URL');
    const serviceRoleKey = config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!url || !serviceRoleKey) {
      // Ngã ngay lúc khởi động, còn hơn để từng request lỗi 500 khó hiểu.
      throw new Error(
        'Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY. Xem .env.example rồi tạo file .env.',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.client = createClient(url, serviceRoleKey, {
      auth: {
        // Backend không có "người dùng đang đăng nhập" để giữ phiên.
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
}
