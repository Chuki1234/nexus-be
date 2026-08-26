import { createClient } from '@supabase/supabase-js';
import * as path from 'path';
import * as fs from 'fs';

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

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

async function testLogin(email, password, roleName) {
  console.log(`\n🔑 Đang thử đăng nhập: ${roleName} (${email})...`);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error(`❌ Đăng nhập thất bại:`, error.message);
  } else {
    console.log(`✅ Đăng nhập THÀNH CÔNG!`);
    console.log(`   User ID: ${data.user.id}`);
    console.log(`   Username: ${data.user.user_metadata?.username}`);
    console.log(`   Display Name: ${data.user.user_metadata?.display_name}`);
    console.log(`   Access Token: ${data.session.access_token.slice(0, 25)}...`);
  }
}

async function main() {
  await testLogin('admin@nexus.com', 'Password123!', 'Admin Account (ITSS Lab Owner)');
  await testLogin('member@nexus.com', 'Password123!', 'Member Account (Regular Member)');
  await testLogin('xp_admin@nexus.com', 'Password123!', 'XP Community Admin');
}

main();
