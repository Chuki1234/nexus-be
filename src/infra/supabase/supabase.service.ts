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

  /**
   * Client dùng khoá công khai, dành cho các lời gọi auth THAY MẶT người dùng
   * (đăng nhập). Tách khỏi `client` vì service_role được Supabase miễn trừ khỏi
   * rate limit và bảo vệ brute-force của GoTrue — đăng nhập đi bằng khoá đó là
   * tự tay gỡ một lớp phòng thủ.
   */
  readonly authClient: SupabaseClient;

  constructor(config: ConfigService) {
    const url = config.get<string>('SUPABASE_URL');
    const serviceRoleKey = config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = config.get<string>('SUPABASE_ANON_KEY');

    if (!url || !serviceRoleKey || !anonKey) {
      // Ngã ngay lúc khởi động, còn hơn để từng request lỗi 500 khó hiểu.
      throw new Error(
        'Thiếu SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY hoặc SUPABASE_ANON_KEY. Xem .env.example rồi tạo file .env.',
      );
    }

    // Backend không có "người dùng đang đăng nhập" để giữ phiên.
    const sessionless = {
      auth: { autoRefreshToken: false, persistSession: false },
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.client = createClient(url, serviceRoleKey, sessionless);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.authClient = createClient(url, anonKey, sessionless);
  }
}
