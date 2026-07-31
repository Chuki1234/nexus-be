#!/usr/bin/env node
/**
 * Kiểm tra `src/shared/` của repo này có khớp repo anh em hay không.
 *
 * nexus-fe và nexus-be là hai repo git tách rời nên không import chéo được;
 * cách duy nhất để dùng chung kiểu là nhân bản thư mục. Script này canh cho bản
 * sao không âm thầm lệch nhau.
 *
 * Bỏ qua `*.spec.ts`: backend chạy jest, frontend chạy vitest, nên test không
 * dùng chung được và cố tình không nằm trong `shared/`.
 *
 * Không tìm thấy repo anh em thì bỏ qua chứ không báo lỗi — CI của từng repo
 * chạy độc lập, ở đó chỉ có một bên.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfName = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
).name;

const siblingName = selfName === 'nexus-be' ? 'nexus-fe' : 'nexus-be';
const selfShared = join(repoRoot, 'src/shared');
const siblingShared = resolve(repoRoot, '..', siblingName, 'src/shared');

if (!existsSync(siblingShared)) {
  console.log(
    `check:shared — bỏ qua, không thấy ${siblingName}/src/shared cạnh repo này.`,
  );
  process.exit(0);
}

/** Đường dẫn tương đối của mọi file .ts (trừ .spec.ts), đã sắp xếp. */
function listFiles(root, base = root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((entry) => {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) return listFiles(full, base);
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) return [];
      return [relative(base, full)];
    })
    .sort();
}

const selfFiles = listFiles(selfShared);
const siblingFiles = listFiles(siblingShared);
const problems = [];

for (const file of selfFiles) {
  if (!siblingFiles.includes(file)) {
    problems.push(`chỉ có ở ${selfName}: ${file}`);
  }
}
for (const file of siblingFiles) {
  if (!selfFiles.includes(file)) {
    problems.push(`chỉ có ở ${siblingName}: ${file}`);
  }
}
for (const file of selfFiles.filter((f) => siblingFiles.includes(f))) {
  const a = readFileSync(join(selfShared, file), 'utf8');
  const b = readFileSync(join(siblingShared, file), 'utf8');
  if (a !== b) {
    problems.push(`nội dung lệch nhau: ${file}`);
  }
}

if (problems.length > 0) {
  console.error(`\ncheck:shared — ${selfName} và ${siblingName} đã lệch nhau:\n`);
  for (const problem of problems) {
    console.error(`  • ${problem}`);
  }
  console.error(
    `\nSửa xong nhớ chép sang cả hai repo rồi chạy lại.\n` +
      `  diff -ru ${selfShared} ${siblingShared}\n`,
  );
  process.exit(1);
}

console.log(
  `check:shared — khớp (${selfFiles.length} file, ${selfName} ↔ ${siblingName}).`,
);
