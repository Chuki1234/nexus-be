# Kế hoạch triển khai: Profile — Widget trò chơi trên hồ sơ

- Project: Nexus (lớp 246)
- Member: Triều Dược
- Nhánh git: `pages/profile/duoc`
  <!-- Bảng Members trong plan-nexus.md ghi `pages/profile/trieu-duoc`, nhưng nhánh
       `pages/profile/duoc` đã tồn tại sẵn trên remote từ các đợt trước. Theo SKILL.md
       Bước 7 ("không tạo nhánh mới nếu nhánh trang đã tồn tại"), dùng lại nhánh có sẵn. -->
- Ngày tạo: 2026-08-25

## Tổng quan

Cột widget trên hồ sơ hiện chỉ là **giao diện chết**: dữ liệu trò chơi là mảng hardcode
trong `profile-tab.ts`, các nút `+ Widget` / `+` / `+ Tag` không có `(click)`, và mọi hồ
sơ đều hiện đúng bốn trò chơi giống nhau. Đợt này làm cho nó **hoạt động thật như
Discord**: chọn loại widget, thêm/xoá trò chơi, thêm/xoá nhãn, lưu xuống database, và
người khác xem `/u/:username` thì thấy đúng dữ liệu đó.

Bốn loại widget (theo ảnh Discord member gửi):

| Widget | Discord gọi | Hạn mức |
|---|---|---|
| Trò Chơi Luân Phiên | Games in Rotation | 5 (có nhãn) |
| Trò Chơi Yêu Thích | Favorite Game | 1 |
| Trò Chơi Tôi Thích | Games I Like | 20 |
| Muốn Chơi | Want to Play | 20 |

**Kiến trúc bắt chước feature "Ứng dụng đã kết nối"** (`connected-apps.service.ts` +
`connections-tab` + popup neo đáy trong `settings-modal.html`) — cũng là danh sách có hạn
mức, thêm qua popup, xoá từng cái, lưu bằng `PATCH /profiles/me` rồi cập nhật
`ProfileStore`. Không sáng chế kiến trúc mới.

**KHÔNG nằm trong scope đợt này:**
- Tab "Hoạt động" (activity feed) — chưa có nguồn dữ liệu nào ở backend, giữ nguyên câu
  "chưa dùng được".
- Tự động phát hiện game đang chạy (`games-tab.ts` ở Cài đặt → Trò chơi đã đăng ký) — đó
  là tính năng khác hẳn, không gộp vào.
- Ảnh bìa game lấy từ store bên ngoài (Steam/IGDB) — đợt này người dùng tự dán link ảnh.

---

## Phase 1: Hợp đồng dữ liệu & Database
Status: PENDING

Mục tiêu (Data):
- **Data** — có chỗ lưu trò chơi trong database, ràng buộc chặt ở cả 3 tầng (DTO backend,
  CHECK constraint SQL, validate client) để dữ liệu rác không lọt vào.
- **Data** — `GET /profiles/me` và `GET /profiles/:username` trả thêm trường `games`.

File/folder dự kiến:
- shared (nhân bản 2 repo): `src/shared/dto/profile.ts` — thêm `ProfileGame`,
  `ProfileGameKind`, `GAME_KIND_LABELS`, `gameLimitFor()`, `GAME_TITLE_MAX`,
  `GAME_TAG_MAX`, `MAX_GAME_TAGS`; thêm `games` vào `PublicProfile` và
  `UpdateProfileRequest`.
- backend: `supabase/migrations/20260825090000_profile_games.sql` (mới)
- backend: `src/modules/profiles/dto/update-profile.dto.ts` — `ProfileGameDto` + trường `games`
- backend: `src/modules/profiles/profiles.service.ts` — thêm `games` vào `PROFILE_COLUMNS`,
  map trong `toPublicProfile`/`toOwnProfile`, xử lý trong `applyPatch`
- backend: `src/modules/profiles/profiles.service.spec.ts` (mới — module này hiện chưa có test nào)

Tiêu chí hoàn thành (Definition of Done):
- `npm run check:shared` báo **khớp** ở cả hai repo (không chỉ exit 0 — phải thấy dòng
  "khớp (N file, nexus-fe ↔ nexus-be)").
- `nest build` sạch lỗi.
- File migration đã viết xong và **đã gửi mentor**; chưa chạy thì phase này ghi "chờ DB",
  không đánh DONE.
- Sau khi mentor chạy migration: `GET /api/profiles/me` trả về `games: []`, `PATCH` với
  mảng game hợp lệ thì lưu được, với dữ liệu sai thì trả **400 kèm câu lỗi rõ ràng** (không
  phải 500).

Test case dự kiến:
- Unit test (Jest): `applyPatch` bỏ khoá thừa trong object game; mảng rỗng = xoá hết;
  `undefined` = giữ nguyên; quá hạn mức từng loại widget → `BadRequestException`.
- E2E Playwright: chưa ở phase này.

### Kết quả Phase 1
- Ngày hoàn thành:
- Commit: frontend `<sha>` · backend `<sha>`
- Kết quả test: unit test `<x/y pass>` · E2E Playwright `<chưa có>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — không áp dụng (phase này không có UI)
  - [ ] **Feature** —
  - [ ] **Data** —
- Migration DB: file `nexus-be/supabase/migrations/20260825090000_profile_games.sql` —
  trạng thái: `<chưa tạo / chờ mentor / đã chạy xong>`
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Phase 2: Thêm & xoá trò chơi chạy thật
Status: PENDING

Mục tiêu (Feature + Data):
- **Feature** — ở Cài đặt → Hồ sơ, bấm `+` trên một widget thì hiện ô nhập tên trò chơi;
  bấm Thêm là lưu ngay xuống database (không cần bấm "Lưu thay đổi").
- **Feature** — hover vào thẻ trò chơi hiện nút xoá; bấm là xoá thật.
- **Data** — validate ở client trước khi gửi (tên rỗng, quá dài, trùng tên, quá hạn mức,
  ảnh bìa không phải `https://`) để người dùng nhận câu lỗi cụ thể thay vì 400 mù.

File/folder dự kiến:
- frontend: `src/app/features/profile/game-catalog.ts` (mới — hằng số + hàm thuần, không
  import Angular, giống `connected-apps.ts`)
- frontend: `src/app/features/profile/profile-games.service.ts` (mới — bắt chước
  `ConnectedAppsService`)
- frontend: `src/app/features/profile/components/profile-widgets-editor/` (mới, tạo bằng
  `ng generate component`)
- frontend: `src/app/features/settings/tabs/profile-tab/profile-tab.html` — thay khối
  widget hardcode bằng `<app-profile-widgets-editor />`
- frontend: `src/app/features/settings/tabs/profile-tab/profile-tab.ts` — xoá
  `GameItem`/`FavoriteGameItem`, hai signal mảng cứng và ba hàm xoá cục bộ
- frontend: `src/app/features/settings/settings-modal.html` — thêm form nhập trò chơi vào
  **đúng wrapper flex đã có** (đừng tạo wrapper `absolute` mới — comment trong file đã cảnh
  báo hai thanh sẽ chồng đè nhau)
- frontend: `src/app/features/settings/services/user-settings.service.ts` — `close()` dọn
  draft đang nhập dở
- frontend: `src/app/features/profile/profile-games.spec.ts` (mới)

Tiêu chí hoàn thành:
- Thêm một trò chơi → F5 lại trang → vẫn còn.
- Vượt hạn mức thì nút bị chặn kèm câu giải thích, không phải im lặng.
- Đang lưu thì nút chuyển sang trạng thái chờ và không bấm được lần hai.
- `ng build` sạch lỗi.

Test case dự kiến:
- Unit test (vitest): payload `PATCH` đúng từng byte; hạn mức chặn ở client; trùng tên bị
  chặn; `busy` chặn request thứ hai.
- E2E Playwright: đăng nhập → Cài đặt → Hồ sơ → thêm 1 trò chơi → F5 → vẫn còn.

### Kết quả Phase 2
- Ngày hoàn thành:
- Commit: frontend `<sha>` · backend `<sha>`
- Kết quả test:
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** —
  - [ ] **Feature** —
  - [ ] **Data** —
- Migration DB: không cần (đã xong ở Phase 1)
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Phase 3: Hộp thoại "Thêm Widget" & nhãn
Status: PENDING

Mục tiêu (UI/UX + Feature):
- **Feature** — nút `+ Widget` mở hộp thoại hai cột: bên trái là nhóm (Sở thích / Thống kê
  trò chơi), bên phải là các loại widget; chọn một loại thì mở luôn ô nhập trò chơi.
- **Feature** — nút `+ Tag` trên thẻ trò chơi thêm nhãn tự do; mỗi nhãn có nút bỏ.
- **UI/UX** — dùng `MatDialog` (Angular Material) theo đúng Design System của repo; đủ
  trạng thái rỗng / đầy / đang lưu / lỗi, mỗi trạng thái là một câu nói rõ phải làm gì.
- **UI/UX** — nút xoá hiện khi hover **và khi focus bàn phím** (chỉ `group-hover` là bàn
  phím không bao giờ tới được → trượt AXE/WCAG AA); mọi nút icon có `aria-label`.

File/folder dự kiến:
- frontend: `src/app/features/profile/components/add-widget-dialog/` (mới, `ng generate component`)
- frontend: `src/app/features/settings/settings-modal.html` — thêm form `+ Tag`
- frontend: `src/app/features/settings/settings-modal.games.spec.ts` (mới)

Tiêu chí hoàn thành:
- Bấm `+ Widget` → chọn "Games I Like" → hiện ô nhập → thêm được.
- Widget đã đầy thì hiện "Đã đầy" và không bấm được.
- Đổi tab hoặc đóng modal thì ô nhập dở tự biến mất.
- Kiểm AXE không còn lỗi trên khu vực widget.

Test case dự kiến:
- Unit test: mở hộp thoại → chọn loại → popup hiện đúng loại đó; thêm/bỏ nhãn; đổi tab thì
  popup biến mất; đóng modal thì draft bị dọn.
- E2E Playwright: thêm 1 nhãn vào trò chơi → F5 → nhãn vẫn còn.

### Kết quả Phase 3
- Ngày hoàn thành:
- Commit: frontend `<sha>` · backend `<sha>`
- Kết quả test:
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** —
  - [ ] **Feature** —
  - [ ] **Data** —
- Migration DB: không cần
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Phase 4: Bản chỉ đọc ở `/u/:username` & bàn giao
Status: PENDING

Mục tiêu (cả 3 tiêu chí):
- **Feature** — trang hồ sơ đầy đủ hiện trò chơi THẬT của người đang xem, không phải hàng mẫu.
- **UI/UX** — bản chỉ đọc tuyệt đối không có nút thêm/xoá (đã có test khoá điều này).
- **Data** — xoá hẳn `placeholder-games.ts`.

File/folder dự kiến:
- frontend: `src/app/features/profile/components/profile-widgets/` (`.ts`, `.html`, `.spec.ts`)
- frontend: `src/app/features/profile/view/view.ts` + `view.html`
- frontend: `src/app/features/profile/placeholder-games.ts` — **XOÁ**
- frontend: cấu hình Playwright (repo hiện chưa có — xem ghi chú bên dưới)

Tiêu chí hoàn thành:
- Mở `/u/<username>` của người khác thấy đúng trò chơi họ đã thêm.
- Chạy lại **toàn bộ** test của cả 4 phase, không phase nào làm hỏng phase trước.
- Điền mục "Tổng kết trang" và cập nhật mô tả PR.

Test case dự kiến:
- Unit test: cập nhật fixture sang `ProfileGame`; giữ nguyên các assert "không có nút xoá".
- E2E Playwright: thêm trò chơi ở Cài đặt → mở `/u/<username>` → thấy đúng trò chơi đó.

### Kết quả Phase 4
- Ngày hoàn thành:
- Commit: frontend `<sha>` · backend `<sha>`
- Kết quả test:
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** —
  - [ ] **Feature** —
  - [ ] **Data** —
- Migration DB: không cần
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Ghi chú quan trọng trước khi bắt đầu

1. **Thứ tự triển khai là bắt buộc, không được đảo.** `PROFILE_COLUMNS` trong
   `profiles.service.ts` liệt kê tên cột gửi cho Supabase. Thêm `games` vào đó **trước khi**
   mentor chạy migration thì **mọi endpoint hồ sơ trả 500** — kể cả `GET /profiles/me`, kể
   cả người không dùng widget. Thứ tự: migration chạy xong → merge backend → merge frontend.

2. **Backend luôn deploy trước frontend.** `main.ts` bật `forbidNonWhitelisted: true`, nên
   frontend gửi trường `games` khi backend chưa biết trường đó sẽ nhận **400**, không phải
   bỏ qua âm thầm. Chiều ngược lại (backend có, frontend chưa gửi) thì vô hại.

3. **`src/shared/` phải giống nhau byte-for-byte giữa hai repo.** Sửa xong luôn `cp -f`
   sang repo kia rồi chạy `npm run check:shared` ở **cả hai** — script này exit 0 im lặng
   khi không thấy repo anh em, nên chỉ tin khi thấy dòng "khớp (N file …)".

4. **Playwright chưa có trong repo** (`package.json` chỉ có vitest, không có
   `playwright.config.*`, không có thư mục `e2e/`). Phase 4 phải tính thêm việc cài và cấu
   hình, hoặc xin mentor miễn E2E cho đợt này và ghi rõ lý do ở đây.

5. **Nhánh này vừa được đồng bộ với `main`** bằng commit merge `dc0e1d3` (lấy bản của
   `main` ở mọi chỗ đụng nhau, vì `main` đã hút hết nội dung cũ của nhánh và viết lại module
   Settings). Giữ lại được phần `LookupStatus` (`loading` / `found` / `missing`) của
   `profile-lookup.ts` — thứ mà `main` chưa có.

---

## Nhật ký duyệt & hoàn thành

| Phase | Duyệt lúc | Hoàn thành lúc | Commit FE | Commit BE | PR |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |

---

## Tổng kết trang

<!-- Điền ở Bước 9, sau khi xong TẤT CẢ phase. Đánh giá cả trang theo 3 tiêu chí. -->
