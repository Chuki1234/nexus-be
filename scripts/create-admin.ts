import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_DATA = {
  email: 'admin@nexus.com',
  username: 'admin',
  displayName: 'Admin',
  password: 'Admin123456@',
  birthdate: '1995-01-01',
};

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('Đang kiểm tra và tạo tài khoản Admin...');

  // 1. Check if user exists in auth.users
  const { data: usersData, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listError) {
    console.error('Lỗi khi lấy danh sách user:', listError.message);
    process.exit(1);
  }

  let userId: string | null = null;
  const existingUser = usersData.users.find(
    (u) => u.email?.toLowerCase() === ADMIN_DATA.email.toLowerCase()
  );

  if (existingUser) {
    console.log(`Tài khoản ${ADMIN_DATA.email} đã tồn tại (id: ${existingUser.id}). Đang cập nhật mật khẩu...`);
    userId = existingUser.id;
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      password: ADMIN_DATA.password,
      email_confirm: true,
      user_metadata: {
        username: ADMIN_DATA.username,
        display_name: ADMIN_DATA.displayName,
      },
    });
    if (updateError) {
      console.error('Lỗi khi cập nhật user:', updateError.message);
      process.exit(1);
    }
  } else {
    console.log(`Đang tạo tài khoản ${ADMIN_DATA.email}...`);
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email: ADMIN_DATA.email,
      password: ADMIN_DATA.password,
      email_confirm: true,
      user_metadata: {
        username: ADMIN_DATA.username,
        display_name: ADMIN_DATA.displayName,
      },
    });

    if (createError) {
      console.error('Lỗi khi tạo user:', createError.message);
      process.exit(1);
    }
    userId = newUser.user.id;
  }

  // 2. Upsert profile
  console.log('Đang cập nhật hồ sơ trong bảng profiles...');
  const { error: profileError } = await supabase.from('profiles').upsert(
    {
      id: userId,
      username: ADMIN_DATA.username,
      display_name: ADMIN_DATA.displayName,
      birthdate: ADMIN_DATA.birthdate,
      bio: 'Hệ thống quản trị viên Nexus.',
    },
    { onConflict: 'id' },
  );

  if (profileError) {
    console.error('Lỗi khi cập nhật profile:', profileError.message);
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('🎉 TÀI KHOẢN ADMIN ĐÃ ĐƯỢC TẠO THÀNH CÔNG!');
  console.log('========================================');
  console.log(`- Email:          ${ADMIN_DATA.email}`);
  console.log(`- Username:       ${ADMIN_DATA.username}`);
  console.log(`- Display Name:   ${ADMIN_DATA.displayName}`);
  console.log(`- Password:       ${ADMIN_DATA.password}`);
  console.log(`- Ngày sinh:      ${ADMIN_DATA.birthdate}`);
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('Lỗi không xác định:', err);
  process.exit(1);
});
