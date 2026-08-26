import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Read .env
const envPath = path.resolve(process.cwd(), '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const rawLine of envContent.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const idx = line.indexOf('=');
  if (idx !== -1) {
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    env[key] = val;
  }
}

const supabaseUrl = env.SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function provisionUser({ email, password, username, displayName, dateOfBirth }) {
  console.log(`\n⏳ Đang khởi tạo tài khoản: ${username} (${email})...`);

  // Check if auth user already exists
  const { data: listData } = await supabase.auth.admin.listUsers();
  const existingUser = listData?.users?.find((u) => u.email === email);

  let userId = existingUser?.id;

  if (existingUser) {
    console.log(`ℹ️ Auth user ${email} đã tồn tại (ID: ${userId}). Đang cập nhật mật khẩu...`);
    await supabase.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      user_metadata: { username, display_name: displayName },
    });
  } else {
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, display_name: displayName },
    });

    if (createError) {
      console.error(`❌ Không tạo được auth user:`, createError.message);
      return;
    }
    userId = createData.user.id;
    console.log(`✅ Đã tạo auth user: ${userId}`);
  }

  // Ensure profile in public.profiles table
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (existingProfile) {
    console.log(`ℹ️ Profile đã tồn tại. Đang cập nhật profile...`);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        username,
        display_name: displayName,
        date_of_birth: dateOfBirth,
      })
      .eq('id', userId);
    if (updateError) {
      console.error(`❌ Lỗi cập nhật profile:`, updateError.message);
    } else {
      console.log(`✅ Đã cập nhật profile thành công.`);
    }
  } else {
    const { error: insertError } = await supabase.from('profiles').insert({
      id: userId,
      username,
      display_name: displayName,
      date_of_birth: dateOfBirth,
    });
    if (insertError) {
      console.error(`❌ Lỗi tạo profile:`, insertError.message);
    } else {
      console.log(`✅ Đã tạo profile thành công.`);
    }
  }
}

async function main() {
  console.log('🚀 Bắt đầu tạo 2 tài khoản: Admin & Member\n========================================');

  // 1. Admin Account
  await provisionUser({
    email: 'admin@nexus.com',
    password: 'Password123!',
    username: 'admin_nexus',
    displayName: 'Quản Trị Viên (Admin)',
    dateOfBirth: '2000-01-01',
  });

  // 2. Member Account
  await provisionUser({
    email: 'member@nexus.com',
    password: 'Password123!',
    username: 'member_nexus',
    displayName: 'Thành Viên (Member)',
    dateOfBirth: '2002-05-15',
  });

  // 3. XP Community Admin
  await provisionUser({
    email: 'xp_admin@nexus.com',
    password: 'Password123!',
    username: 'xp_admin',
    displayName: 'Quản Trị Viên XP (XP Admin)',
    dateOfBirth: '2001-07-20',
  });

  console.log('\n========================================');
  console.log('🎉 HOÀN TẤT TẠO TÀI KHOẢN!');
}

main();
