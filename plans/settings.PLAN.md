# Kế hoạch triển khai: Settings

- Project: Nexus
- Member: Trường Giang
- Nhánh git: pages/settings/truong-giang <!-- điền chính xác sau khi nhánh được tạo ở Phase 1, Bước 7 của SKILL.md -->
- Ngày tạo: 2026-08-19

## Tổng quan
Trang Setting theo `reference/plan-nexus.md`: setting account (thông tin cá nhân, đổi ngôn ngữ,
đăng xuất, tuỳ chỉnh thông báo, đổi mật khẩu, 2FA), setting server (profile, quyền, phân quyền,
mời), setting channel. Phiên làm việc này KHÔNG làm toàn bộ trang từ đầu — trang đã có sẵn UI
dựng trước (account-tab, privacy-tab, v.v. đã tồn tại trong `features/settings/`). Scope của
Phase 1 chỉ là dọn dẹp: gỡ 2 mục UI không thuộc scope của trang Setting theo `reference/plan-nexus.md`
(không có "Trung tâm Gia đình" hay "Mã hoá đầu cuối giọng nói" trong danh sách Feature) mà member
xác nhận muốn xoá khỏi cả sidebar điều hướng lẫn nội dung tab. Các phase sau (nếu có) sẽ tiếp tục
hoàn thiện phần còn lại của trang Setting.

---

## Phase 1: Gỡ "Trung Tâm Gia Đình", nav "Mã Hóa Đầu Cuối Giọng Nói", và "Xác Thực Đa Nhân Tố"
Status: APPROVED <!-- member tự sửa thành APPROVED sau khi đọc và đồng ý -->

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **Feature**: Loại bỏ khỏi UI 3 mục theo yêu cầu trực tiếp của member (page owner):
  (a) toàn bộ block "SECTION 4 – TRUNG TÂM GIA ĐÌNH" (tiêu đề + card "Kết nối với Phụ huynh /
  Người giám hộ") trong `account-tab.html`, và mục nav con "Trung Tâm Gia Đình" trỏ tới nó trong
  `settings-modal.ts` — mục này không thuộc danh sách Feature chính thức của trang Setting
  trong `reference/plan-nexus.md`;
  (b) mục nav con "Mã Hóa Đầu Cuối Giọng Nói" (actionId `privacy-encryption-heading`) trong
  `settings-modal.ts` — mục này thực ra trỏ tới toggle "Cho phép giọng nói của tôi được ghi lại
  trong Clip" trong `privacy-tab.html`, không liên quan tới mã hoá đầu cuối, nên chỉ gỡ nav
  shortcut gây hiểu nhầm, **giữ nguyên** toggle Voice Clip Recording thật (setting hợp lệ, không
  phải thứ member yêu cầu xoá);
  (c) toàn bộ UI "Xác Thực Đa Nhân Tố" (2FA) trong `account-tab.html`: row bật/tắt 2FA, khối mã
  sao lưu dự phòng (backup codes), và row "Mã Dự Phòng 2FA" phụ thuộc. **Lưu ý riêng cho mục
  (c)**: 2FA là feature được liệt kê chính thức trong `reference/plan-nexus.md` cho trang
  Setting ("đổi mật khẩu, 2FA") — khác 2 mục (a)/(b) vốn không nằm trong đề bài. Member (page
  owner, đã xác nhận qua AskUserQuestion ngày 2026-08-19) chủ động chọn bỏ hẳn UI này khỏi web
  thay vì chỉ ẩn tạm; ghi nhận đây là quyết định lệch khỏi Feature list gốc, mentor Luke có thể
  hỏi lại lý do khi review PR.
- **UI/UX**: Sau khi xoá, layout account-tab và sidebar settings không còn khoảng trống/heading
  mồ côi, vẫn theo đúng style hiện có (không đổi token/spacing của các section còn lại).

File/folder dự kiến:
- frontend:
  - `src/app/features/settings/tabs/account-tab/account-tab.html` (xoá SECTION 4 "Trung Tâm Gia
    Đình" + toàn bộ row/khối liên quan tới 2FA trong SECTION 2)
  - `src/app/features/settings/settings-modal.ts` (xoá 2 dòng subItem trong `userCategories`:
    "Trung Tâm Gia Đình" và "Mã Hóa Đầu Cuối Giọng Nói")
  - Nếu component `account-tab.ts` có state/method chỉ phục vụ 2FA (`twoFactorEnabled`,
    `showBackupCodes`, `backupCodes`, `toggleTwoFactor`, nút `#btn-toggle-2fa`,
    `#btn-show-backup-codes`...) và không còn nơi nào khác dùng tới sau khi xoá template — dọn
    luôn phần code chết tương ứng để tránh field/method mồ côi.
- backend: không cần thay đổi — đây thuần là dọn UI tĩnh, không có API/dữ liệu liên quan.

Tiêu chí hoàn thành (Definition of Done):
- Mở Settings → tab Tài Khoản: không còn heading "Trung Tâm Gia Đình", card "Kết nối với Phụ
  huynh / Người giám hộ", row "Xác Thực Đa Nhân Tố", khối mã sao lưu dự phòng, hay row "Mã Dự
  Phòng 2FA".
- Sidebar mục "Tài Khoản" không còn sub-item "Trung Tâm Gia Đình"; sidebar mục "Dữ Liệu & Bảo
  Mật" không còn sub-item "Mã Hóa Đầu Cuối Giọng Nói".
- Tab Dữ Liệu & Bảo Mật vẫn còn nguyên toggle "Cho phép giọng nói của tôi được ghi lại trong
  Clip" hoạt động bình thường (chỉ mất shortcut nav, không mất chức năng).
- Không còn field/method/signal chết liên quan riêng tới 2FA trong `account-tab.ts` sau khi xoá
  template dùng chúng.
- `ng build` sạch lỗi.

Test case dự kiến:
- Unit test: không cần thêm (không có logic mới, chỉ xoá template/markup tĩnh + dọn code chết).
- E2E / workflow test (Playwright): mở Settings, xác nhận không tìm thấy text "Trung Tâm Gia
  Đình", "Mã Hóa Đầu Cuối Giọng Nói", "Xác Thực Đa Nhân Tố" ở đâu trong DOM của settings modal;
  xác nhận toggle Voice Clip Recording trong tab Dữ Liệu & Bảo Mật vẫn render và bấm được.

### Kết quả Phase 1
- Ngày hoàn thành: 2026-08-19
- Commit: frontend `<sha ngắn>` · backend (không có thay đổi)
- Kết quả test: unit test `-` · E2E Playwright `<x/y pass>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — <ghi chú>
  - [ ] **Feature** — <ghi chú>
  - [ ] **Data** — không áp dụng (không đụng dữ liệu/API)
- Vấn đề phát sinh / ghi chú:
- PR: <link hoặc số PR>

---

## Phase 2: Gộp nút gear+chevron của header server, và tách hẳn Settings User/Server (bỏ mode switcher)
Status: APPROVED <!-- member tự sửa thành APPROVED sau khi đọc và đồng ý -->

**Lưu ý phạm vi**: Phase này bắt buộc phải sửa 2 file thuộc `layouts/app-layout/` (hạ tầng dùng
chung, không phải riêng trang Setting) vì đó là nơi đặt nút mở Settings (cả server lẫn user).
Theo quy tắc Bước 3 mục (c) của SKILL.md, việc này được phép nhưng phải khai rõ ở đây và báo lại
nhóm — vì `layouts/` có thể ảnh hưởng tới trải nghiệm của các trang khác, nên nếu member khác
đang chỉnh sửa `channel-sidebar` hoặc `user-panel` cùng lúc thì nên báo trước khi merge để tránh
conflict git.

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **UI/UX (yêu cầu 1)**: Gộp cặp icon "gear" (nút riêng, có `stopPropagation`, mở thẳng Server
  Overview) + "expand_more" (chevron, chỉ là icon trang trí bên trong vùng đã có
  `matMenuTriggerFor`) trong header server ở `channel-sidebar.html` thành **1 nút duy nhất**. Vì
  cả header đã trigger dropdown menu khi click (và menu đã có sẵn mục "Tổng quan máy chủ" trỏ
  đúng hành động mà nút gear cũ làm), cách gộp: xoá nút `<button>` gear riêng lẻ (id ngầm định
  qua `matTooltip="Cài đặt máy chủ"`), chỉ giữ lại 1 icon chevron duy nhất làm điểm nhấn trực quan
  cho việc "đây là khu vực có thể click để mở menu" — không mất chức năng gì vì "Tổng quan máy
  chủ" trong menu vẫn đưa thẳng tới đúng trang server-overview.
- **UI/UX (yêu cầu 2)**: Bỏ hẳn "Mode Switcher" (2 nút "Người dùng" / "Server ADMIN") trong
  sidebar trái của `settings-modal.html` — thay vì cho phép chuyển qua lại tự do trong 1 modal,
  mỗi điểm vào (entry point) khoá cứng đúng 1 chế độ:
  - Bấm gear ở `channel-sidebar` (`openServerSettings(...)`) → modal chỉ hiện Server Settings,
    không có cách nào bấm sang User Settings từ trong modal (trừ nút escape "Quay lại Cài đặt Cá
    nhân" khi bị chặn quyền truy cập — giữ nguyên nút này vì nó không phải switcher tự do, chỉ là
    lối thoát khi thiếu quyền).
  - Bấm mở Settings từ `user-panel` (icon bánh răng ở góc dưới trái) → hiện tại đang gọi
    `settingsService.open('account')` (method chung, KHÔNG ép `settingsMode`), nên nếu trước đó
    modal từng ở chế độ 'server' thì mở lại vẫn có thể dính mode cũ. Sửa `user-panel.ts` gọi
    `settingsService.openUserSettings('account')` thay vì `open('account')` để luôn khoá đúng
    'user' mode khi vào từ lối này.
- **Feature**: Không đổi hành vi nghiệp vụ nào (không thêm/bớt tab nào có sẵn), chỉ đổi cách vào
  và rời khỏi 2 nhóm setting.

File/folder dự kiến:
- frontend:
  - `src/app/features/settings/settings-modal.html` (xoá khối "Mode Switcher" — 2 nút Người
    dùng/Server ADMIN; giữ nguyên nút "Quay lại Cài đặt Cá nhân" ở nhánh no-permission)
  - `src/app/features/settings/settings-modal.ts` (nếu `switchMode('server')` không còn được gọi
    ở đâu sau khi xoá switcher, cân nhắc giữ lại method vì `switchMode('user')` vẫn dùng ở nút
    escape — chỉ xoá phần code chết thật sự nếu có)
  - `src/app/layouts/app-layout/components/channel-sidebar/channel-sidebar.html` (gộp gear +
    chevron thành 1 icon/nút) — **thuộc layouts/, hạ tầng dùng chung, đã khai báo ở trên**
  - `src/app/layouts/app-layout/components/user-panel/user-panel.ts` (đổi `open('account')` →
    `openUserSettings('account')`) — **thuộc layouts/, hạ tầng dùng chung, đã khai báo ở trên**
- backend: không cần thay đổi.

Tiêu chí hoàn thành (Definition of Done):
- Header server trong channel sidebar chỉ còn 1 icon bên phải tên server (không còn 2 icon tách
  biệt), click vẫn mở đúng menu ngữ cảnh, mục "Tổng quan máy chủ" trong menu vẫn mở đúng Server
  Settings.
- Bấm gear server → modal mở đúng Server Settings, sidebar trái KHÔNG còn 2 nút chuyển mode.
- Bấm icon Settings ở user-panel (góc dưới trái) → modal mở đúng User Settings (tab Tài Khoản),
  sidebar trái KHÔNG còn 2 nút chuyển mode, kể cả khi trước đó vừa đóng modal từ chế độ Server.
- Nút "Quay lại Cài đặt Cá nhân" ở màn hình "Truy Cập Bị Giới Hạn" vẫn hoạt động (đưa về User
  Settings) vì đây là lối thoát hợp lệ, không phải switcher tự do.
- `ng build` sạch lỗi.

Test case dự kiến:
- Unit test: không cần thêm (thuần UI/routing nội bộ component).
- E2E / workflow test (Playwright): (1) mở app, bấm gear server → assert chỉ thấy nav Server
  Settings, không có 2 nút mode switcher; (2) đóng modal, bấm icon settings ở user-panel → assert
  chỉ thấy nav User Settings, không có 2 nút mode switcher; (3) hover/click vùng icon header
  server → chỉ có 1 element icon, không phải 2.

### Kết quả Phase 2
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend (không có thay đổi)
- Kết quả test: unit test `-` · E2E Playwright `<x/y pass>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — <ghi chú>
  - [ ] **Feature** — <ghi chú>
  - [ ] **Data** — không áp dụng
- Vấn đề phát sinh / ghi chú:
- PR: <link hoặc số PR>

---

## Nhật ký duyệt & hoàn thành (bảng tóm tắt nhanh — chi tiết xem mục "Kết quả Phase N" ở trên)
| Phase | Duyệt lúc | Hoàn thành lúc | Test pass | Commit |
| --- | --- | --- | --- | --- |
| 1 | 2026-08-19 | | | |
| 2 | | | | |
