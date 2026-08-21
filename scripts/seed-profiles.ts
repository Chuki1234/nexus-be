/**
 * Tạo dữ liệu mẫu để thử tính năng Profile.
 *
 *   npm run seed          — tạo (hoặc cập nhật) các tài khoản mẫu
 *   npm run seed -- --clean — xoá sạch các tài khoản mẫu đó
 *
 * Đi qua Admin API của Supabase chứ không chèn tay vào `auth.users`: bảng đó có
 * ràng buộc và bảng phụ (auth.identities) thay đổi theo phiên bản GoTrue, tự
 * chèn thì tạo ra tài khoản trông thì có mà đăng nhập không được.
 *
 * Ảnh đại diện / ảnh bìa được sinh tại chỗ rồi upload lên đúng bucket qua đúng
 * đường mà ứng dụng dùng, nên chạy script này cũng là một lần kiểm tra Storage.
 *
 * ĐIỀU KIỆN: migration profile_feature đã được áp lên database.
 */
import { config } from 'dotenv';
import sharp from 'sharp';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Mật khẩu chung cho mọi tài khoản mẫu — đây là dữ liệu test, không phải thật. */
const SEED_PASSWORD = 'nexus-seed-2026';

/** Nhận diện tài khoản do script tạo, để `--clean` không xoá nhầm người thật. */
const SEED_MARKER = 'nexus_seed';

interface SeedProfile {
  email: string;
  username: string;
  displayName: string | null;
  birthdate: string;
  statusMessage: string | null;
  bio: string | null;
  location: string | null;
  links: { label: string; url: string }[];
  /** Ảnh nào được sinh: cả hai, chỉ avatar, hay không ảnh nào. */
  images: 'both' | 'avatar-only' | 'none';
  /** Cặp màu để sinh ảnh. Bỏ qua khi `images` là 'none'. */
  palette: { base: string; accent: string; accent2: string } | null;
}

/**
 * Mỗi hồ sơ nhắm vào một trạng thái giao diện khác nhau — đủ ảnh, thiếu ảnh,
 * kín chữ, trống trơn — để xem trang hiển thị ra sao ở từng trường hợp.
 */
const SEED_PROFILES: SeedProfile[] = [
  {
    // Hồ sơ đầy đủ nhất: có mọi thứ, 5 link (chạm trần).
    email: 'mai.tran@example.com',
    username: 'maitran',
    displayName: 'Mai Trần',
    birthdate: '1998-04-12',
    statusMessage: 'Đang xây một thứ gì đó bằng Angular và quá nhiều cà phê ☕',
    bio: 'Frontend engineer ở Đà Nẵng. Mê design system, animation mượt và những dòng CSS không ai phải đọc lại lần hai.\n\nCuối tuần thì leo núi hoặc ngồi cà phê sửa portfolio lần thứ 40.',
    location: 'Đà Nẵng, Việt Nam',
    links: [
      { label: 'GitHub', url: 'https://github.com/maitran' },
      { label: 'Portfolio', url: 'https://maitran.dev' },
      { label: 'Dribbble', url: 'https://dribbble.com/maitran' },
      { label: 'LinkedIn', url: 'https://linkedin.com/in/maitran' },
      { label: 'Blog', url: 'https://blog.maitran.dev/bai-viet-moi-nhat' },
    ],
    images: 'both',
    palette: { base: '#0f3d2e', accent: '#00d992', accent2: '#2fd6a1' },
  },
  {
    // Có avatar, KHÔNG có banner — xem khối ảnh bìa rỗng trông thế nào.
    email: 'duc.pham@example.com',
    username: 'ducpham',
    displayName: 'Đức Phạm',
    birthdate: '2001-11-03',
    statusMessage: 'Học Rust ngày thứ 4. Vẫn đang cãi nhau với borrow checker.',
    bio: 'Sinh viên năm cuối. Thích backend, database và mọi thứ chạy trong terminal.',
    location: 'Hà Nội',
    links: [{ label: 'GitHub', url: 'https://github.com/ducpham' }],
    images: 'avatar-only',
    palette: { base: '#1a1a2e', accent: '#4a7dff', accent2: '#8ab4ff' },
  },
  {
    // Trống gần như hoàn toàn — kiểm tra avatar chữ cái và các câu "chưa có…".
    email: 'linh.vo@example.com',
    username: 'linhvo',
    displayName: null,
    birthdate: '2005-07-21',
    statusMessage: null,
    bio: null,
    location: null,
    links: [],
    images: 'none',
    palette: null,
  },
  {
    // Chữ dài chạm trần: status 120, bio 300, tên hiển thị 32 ký tự.
    email: 'hoang.le@example.com',
    username: 'hoangle',
    displayName: 'Hoàng Lê Nguyễn Minh Anh Tuấn',
    birthdate: '1995-01-30',
    statusMessage:
      'Dòng trạng thái này cố tình viết thật dài để xem giao diện cắt chữ ra sao khi người dùng gõ kín cả trăm hai ký tự',
    // Đúng 300 ký tự — chạm sát trần `profiles_bio_length`.
    bio: 'Đoạn giới thiệu này được viết dài đúng bằng giới hạn cho phép để kiểm tra cách trang xuống dòng và giãn khối. Ba trăm ký tự nghe thì nhiều nhưng gõ ra lại hết rất nhanh, nhất là khi người viết có xu hướng kể lể dông dài về những thứ chẳng ai hỏi tới, kiểu như con mèo nhà mình hôm nay tên là chi.',
    location: 'Thành phố Hồ Chí Minh, Việt Nam',
    links: [
      { label: 'Một cái nhãn dài ba mươi hai ký', url: 'https://example.com/mot-duong-dan-kha-dai-de-xem-cat-chu' },
      { label: 'X', url: 'https://x.com/hoangle' },
    ],
    images: 'both',
    palette: { base: '#3d1a2e', accent: '#ff7b72', accent2: '#ffb4a8' },
  },
];

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    fail('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env');
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  assertWithinLimits();
  await assertReady(supabase);

  if (process.argv.includes('--clean')) {
    await clean(supabase);
    return;
  }

  for (const seed of SEED_PROFILES) {
    await seedOne(supabase, seed);
  }

  report();
}

/**
 * Soát độ dài trước khi gọi mạng.
 *
 * Dữ liệu mẫu cố tình viết sát trần cho phép, nên rất dễ lỡ tay vượt. Để database
 * bắt thì lỗi nổ ở giữa vòng lặp, sau khi vài hồ sơ đã ghi xong và vài tấm ảnh đã
 * nằm trong bucket — dọn lại mệt hơn là kiểm ngay từ đầu.
 */
function assertWithinLimits(): void {
  const limits: [keyof SeedProfile, number][] = [
    ['displayName', 32],
    ['statusMessage', 120],
    ['bio', 300],
    ['location', 64],
  ];

  const problems: string[] = [];
  for (const seed of SEED_PROFILES) {
    for (const [field, max] of limits) {
      const value = seed[field];
      if (typeof value === 'string' && value.length > max) {
        problems.push(`@${seed.username}.${field}: ${value.length}/${max} ký tự`);
      }
    }
    for (const link of seed.links) {
      if (link.label.length > 32) {
        problems.push(`@${seed.username} nhãn link "${link.label}": ${link.label.length}/32`);
      }
      if (!/^https:\/\/[^\s]+$/.test(link.url)) {
        problems.push(`@${seed.username} link "${link.url}" phải là https, không khoảng trắng`);
      }
    }
    if (seed.links.length > 5) {
      problems.push(`@${seed.username} có ${seed.links.length} link, tối đa 5`);
    }
  }

  if (problems.length) {
    fail(`Dữ liệu mẫu vượt giới hạn:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Dừng sớm với thông báo rõ ràng nếu key sai hoặc migration chưa chạy — hai lỗi
 * này nếu để script tự vấp sẽ hiện ra dưới dạng thông báo khó hiểu ở giữa chừng.
 */
async function assertReady(supabase: SupabaseClient): Promise<void> {
  const { error: authError } = await supabase.auth.admin.listUsers({ perPage: 1 });
  if (authError) {
    fail(
      `Không gọi được Admin API: ${authError.message}\n` +
        'Kiểm tra SUPABASE_SERVICE_ROLE_KEY có đúng project trong SUPABASE_URL không.',
    );
  }

  // `links` chỉ tồn tại sau migration profile_feature.
  const { error: schemaError } = await supabase.from('profiles').select('links').limit(1);
  if (schemaError) {
    fail(
      `Bảng profiles chưa có cột của tính năng Profile: ${schemaError.message}\n` +
        'Chạy migration 20260807103000_profile_feature.sql trước (npx supabase db push,\n' +
        'hoặc dán nội dung file đó vào SQL Editor trên dashboard).',
    );
  }
}

async function seedOne(supabase: SupabaseClient, seed: SeedProfile): Promise<void> {
  const userId = await ensureUser(supabase, seed);

  const images = await syncImages(supabase, userId, seed);

  const { error } = await supabase.from('profiles').upsert(
    {
      id: userId,
      username: seed.username,
      display_name: seed.displayName,
      birthdate: seed.birthdate,
      status_message: seed.statusMessage,
      bio: seed.bio,
      location: seed.location,
      links: seed.links,
      avatar_url: images.avatarUrl,
      banner_url: images.bannerUrl,
    },
    { onConflict: 'id' },
  );

  if (error) {
    fail(`Ghi hồ sơ @${seed.username} thất bại: ${error.message}`);
  }
  console.log(`  ✓ @${seed.username.padEnd(10)} ${seed.email}`);
}

/** Tạo tài khoản, hoặc dùng lại nếu email đã tồn tại (script chạy lại được nhiều lần). */
async function ensureUser(supabase: SupabaseClient, seed: SeedProfile): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email: seed.email,
    password: SEED_PASSWORD,
    // Dự án chưa cấu hình SMTP nên không có thư xác nhận để bấm.
    email_confirm: true,
    app_metadata: { [SEED_MARKER]: true },
  });

  if (!error) {
    return data.user.id;
  }
  if (error.code !== 'email_exists') {
    fail(`Tạo tài khoản ${seed.email} thất bại: ${error.message}`);
  }

  const existing = await findByEmail(supabase, seed.email);
  if (!existing) {
    fail(`${seed.email} đã tồn tại nhưng không tìm lại được — xoá tay rồi chạy lại.`);
  }
  return existing.id;
}

async function findByEmail(supabase: SupabaseClient, email: string): Promise<User | null> {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    fail(`Không đọc được danh sách tài khoản: ${error.message}`);
  }
  return data.users.find((user) => user.email === email) ?? null;
}

/**
 * Đưa bucket về đúng trạng thái `seed.images` mô tả — upload cái cần có, xoá cái
 * không cần. Có bước xoá vì script chạy lại được: đổi một hồ sơ từ 'both' sang
 * 'avatar-only' mà không dọn thì file bìa cũ vẫn nằm đó, và lần chạy sau lại
 * dựng lên một trạng thái khác với những gì dữ liệu mẫu khai báo.
 *
 * Ảnh vẽ bằng SVG chỉ gồm hình khối, không có chữ: kết xuất chữ trong SVG phụ
 * thuộc font hệ thống, máy thiếu font sẽ ra ảnh trống.
 */
async function syncImages(
  supabase: SupabaseClient,
  userId: string,
  seed: SeedProfile,
): Promise<{ avatarUrl: string | null; bannerUrl: string | null }> {
  const wantAvatar = seed.images !== 'none';
  const wantBanner = seed.images === 'both';
  const palette = seed.palette;

  if (!palette && (wantAvatar || wantBanner)) {
    fail(`@${seed.username} khai báo có ảnh nhưng thiếu palette.`);
  }

  const avatarPath = `${userId}/avatar.webp`;
  const bannerPath = `${userId}/banner.webp`;

  const avatarUrl =
    wantAvatar && palette
      ? await upload(supabase, 'avatars', avatarPath, await renderWebp(shapesSvg(512, 512, palette), 82))
      : await remove(supabase, 'avatars', avatarPath);

  const bannerUrl =
    wantBanner && palette
      ? await upload(supabase, 'banners', bannerPath, await renderWebp(shapesSvg(1500, 500, palette), 80))
      : await remove(supabase, 'banners', bannerPath);

  return { avatarUrl, bannerUrl };
}

/** Xoá file rồi trả `null` để gán thẳng vào cột URL. */
async function remove(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
): Promise<null> {
  await supabase.storage.from(bucket).remove([path]);
  return null;
}

function shapesSvg(
  width: number,
  height: number,
  { base, accent, accent2 }: NonNullable<SeedProfile['palette']>,
): string {
  const r = Math.min(width, height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${base}"/>
    <circle cx="${width * 0.75}" cy="${height * 0.25}" r="${r * 0.42}" fill="${accent}" opacity="0.85"/>
    <circle cx="${width * 0.2}" cy="${height * 0.8}" r="${r * 0.3}" fill="${accent2}" opacity="0.55"/>
    <rect x="0" y="${height * 0.62}" width="${width}" height="${height * 0.06}" fill="${accent}" opacity="0.35"/>
  </svg>`;
}

function renderWebp(svg: string, quality: number): Promise<Buffer> {
  return sharp(Buffer.from(svg)).webp({ quality }).toBuffer();
}

async function upload(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  body: Buffer,
): Promise<string> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, body, { contentType: 'image/webp', upsert: true, cacheControl: '31536000' });

  if (error) {
    fail(
      `Upload ${bucket}/${path} thất bại: ${error.message}\n` +
        'Bucket avatars/banners được tạo trong migration profile_feature — đã chạy chưa?',
    );
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

/** Xoá tài khoản mẫu. Hồ sơ trong `profiles` tự đi theo nhờ ON DELETE CASCADE. */
async function clean(supabase: SupabaseClient): Promise<void> {
  console.log('Đang xoá tài khoản mẫu…\n');

  for (const seed of SEED_PROFILES) {
    const user = await findByEmail(supabase, seed.email);
    if (!user) {
      console.log(`  – ${seed.email} (không có)`);
      continue;
    }
    // Chặn tai nạn: chỉ xoá thứ chính script này đã đánh dấu.
    if (!user.app_metadata?.[SEED_MARKER]) {
      console.log(`  ! ${seed.email} không phải tài khoản mẫu — bỏ qua`);
      continue;
    }

    await supabase.storage.from('avatars').remove([`${user.id}/avatar.webp`]);
    await supabase.storage.from('banners').remove([`${user.id}/banner.webp`]);

    const { error } = await supabase.auth.admin.deleteUser(user.id);
    console.log(error ? `  ! ${seed.email}: ${error.message}` : `  ✓ ${seed.email}`);
  }
}

function report(): void {
  console.log('\nXong. Đăng nhập tại http://localhost:4200/login\n');
  console.log(`  Mật khẩu chung: ${SEED_PASSWORD}\n`);
  console.log('  Email                      Trang hồ sơ');
  console.log('  ─────────────────────────  ──────────────────────────────');
  for (const seed of SEED_PROFILES) {
    console.log(`  ${seed.email.padEnd(25)}  http://localhost:4200/u/${seed.username}`);
  }
  console.log('\n  Gõ "mai", "duc"… vào ô tìm kiếm trên trang hồ sơ để thử tìm người.');
  console.log('  Dọn dẹp: npm run seed -- --clean\n');
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

void main();
