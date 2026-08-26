async function registerUser(payload) {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`✅ Tạo tài khoản thành công: ${payload.username} (${payload.email})`);
      console.log(data);
    } else {
      console.log(`ℹ️ Phản hồi từ server cho ${payload.username}:`, data);
    }
  } catch (err) {
    console.error(`❌ Lỗi khi gửi request cho ${payload.username}:`, err.message);
  }
}

async function main() {
  console.log('--- Đang tạo tài khoản Admin ---');
  await registerUser({
    email: 'admin@nexus.local',
    password: 'Password123!',
    username: 'admin_nexus',
    displayName: 'Admin Nexus',
    dateOfBirth: '2000-01-01',
  });

  console.log('\n--- Đang tạo tài khoản Member ---');
  await registerUser({
    email: 'member@nexus.local',
    password: 'Password123!',
    username: 'member_nexus',
    displayName: 'Member Nexus',
    dateOfBirth: '2002-05-15',
  });
}

main();
