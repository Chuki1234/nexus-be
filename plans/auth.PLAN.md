# Kế hoạch triển khai: Auth (Login / Register)

- Project: Nexus
- Member: Luke (mentor — không nằm trong bảng phân công member; xem mục "Ghi chú về git")
- Nhánh git: <chưa chốt — xem mục "Ghi chú về git" cuối file>
- Ngày tạo: 2026-08-16

## Tổng quan

Thêm **lưu nháp form (form draft) vào localStorage** cho hai trang `login` và `register`, để
người dùng F5 / đóng tab / lỡ bấm back rồi quay lại thì không phải gõ lại từ đầu.

Thuộc nhóm Feature "đăng nhập / đăng ký" của trang `auth` trong `reference/plan-nexus.md`.
Đây là cải thiện UX cho form đã chạy được, **không phải** làm mới luồng auth.

**Nguyên tắc bất di bất dịch của đợt này: KHÔNG bao giờ ghi mật khẩu xuống localStorage.**
localStorage là plaintext, mọi script chạy trên origin đều đọc được, và nó sống qua cả lần
tắt máy. Mật khẩu (và mọi token) nằm ngoài phạm vi lưu, không có ngoại lệ.

### KHÔNG nằm trong scope đợt này
- Trang `forgot-password` và `complete-profile` — form ngắn/một lần, lưu nháp không đáng.
- "Ghi nhớ đăng nhập" / auto-login — đó là chuyện của session Supabase, khác hẳn lưu nháp form.
- Backend: **không có thay đổi nào**. Không thêm/sửa bảng, không migration DB.

### Ba tiêu chí áp vào đợt này nghĩa là gì
- **UI/UX** — không đổi giao diện. Ràng buộc là *không được làm hỏng* cái đang có: khôi phục
  nháp không được làm form dính `touched` (sẽ hiện đỏ lỗi ngay khi vừa mở trang), không được
  gây nhấp nháy do hydration SSR.
- **Feature** — reload lại trang thì các ô đã điền (trừ mật khẩu) còn nguyên.
- **Data** — ở đợt này "data" là **vệ sinh dữ liệu phía client**, không phải DB: lưu đúng
  whitelist field, có hạn dùng, tự xoá khi đăng ký/đăng nhập thành công, và chịu được khi
  dữ liệu trong localStorage bị hỏng/bị sửa tay.

---

## Phase 1: Service lưu nháp + áp vào trang Register
Status: PENDING <!-- sửa thành APPROVED khi đồng ý; agent chỉ code khi thấy đúng chữ APPROVED ở dòng này -->

Mục tiêu (gắn với 3 tiêu chí):
- **Feature**: điền form đăng ký rồi F5 → email, tên hiển thị, tên đăng nhập, ngày/tháng/năm
  sinh còn nguyên; ô mật khẩu **trống**.
- **Data**: chỉ ghi đúng 6 field whitelist. Nháp có hạn 24 giờ, quá hạn thì bỏ qua và tự xoá.
  Đăng ký thành công → xoá nháp ngay (không để email/ngày sinh nằm lại trên máy dùng chung).
  JSON hỏng hoặc thiếu field → bỏ qua im lặng, không làm chết trang.
- **UI/UX**: form khôi phục ở trạng thái `pristine`/`untouched` — mở trang không thấy dòng đỏ
  nào. Chạy được dưới SSR (không đụng `localStorage` khi render phía server).

File/folder dự kiến:
- frontend:
  - `src/app/features/auth/services/auth-form-draft.service.ts` (tạo mới, bằng `ng g s`)
  - `src/app/features/auth/services/auth-form-draft.service.spec.ts` (unit test)
  - `src/app/features/auth/register/register.ts` (sửa: nạp nháp lúc khởi tạo, lưu khi form đổi,
    xoá khi đăng ký thành công)
  - `e2e/auth-draft.spec.ts` (E2E Playwright — thêm Playwright vào repo nếu chưa có)
- backend: không có thay đổi.

Tiêu chí hoàn thành (Definition of Done):
- `ng build` sạch lỗi.
- Điền form → F5 → 5 ô text/select giữ nguyên giá trị, ô mật khẩu trống.
- Mở DevTools → Application → Local Storage: **không tìm thấy chuỗi mật khẩu vừa gõ** ở bất kỳ key nào.
- Đăng ký thành công → key nháp biến mất khỏi localStorage.
- Sửa tay giá trị trong localStorage thành chuỗi rác → mở lại trang: form trống, không lỗi console.
- Mở trang lần đầu (chưa có nháp) → không có dòng đỏ lỗi validate nào.

Test case dự kiến:
- Unit test (Jest/Karma): lưu rồi đọc lại ra đúng object; payload có `password` thì field đó bị
  loại khỏi dữ liệu ghi; nháp quá 24h trả `null`; JSON hỏng trả `null` không throw; chạy trong
  môi trường không có `localStorage` (giả lập SSR) không throw.
- E2E Playwright: điền đủ form đăng ký (kể cả mật khẩu) → `page.reload()` → assert từng ô có giá
  trị cũ, riêng ô mật khẩu assert rỗng; và assert `localStorage` không chứa chuỗi mật khẩu.

### Kết quả Phase 1
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend `<không có thay đổi>`
- Kết quả test: unit test `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** —
  - [ ] **Feature** —
  - [ ] **Data** —
- Migration DB: **chưa cần** (đợt này không đụng DB).
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Phase 2: Áp vào trang Login + dọn nháp khi đăng nhập thành công
Status: PENDING

Mục tiêu (gắn với 3 tiêu chí):
- **Feature**: gõ email/tên đăng nhập ở trang Login rồi F5 → ô định danh còn nguyên, ô mật khẩu trống.
- **Data**: đăng nhập thành công → xoá **cả nháp login lẫn nháp register**. Lý do xoá cả hai:
  đăng nhập được nghĩa là nháp đăng ký còn sót lại đã vô nghĩa, giữ lại chỉ tổ để lộ email/ngày
  sinh của người trước trên máy dùng chung.
- **UI/UX**: giống Phase 1 — không đổi giao diện, không hiện lỗi đỏ khi vừa mở trang.

File/folder dự kiến:
- frontend:
  - `src/app/features/auth/login/login.ts` (sửa)
  - `src/app/features/auth/services/auth-form-draft.service.ts` (mở rộng: thêm khoá cho login)
  - `e2e/auth-draft.spec.ts` (bổ sung ca cho login)
- backend: không có thay đổi.

Tiêu chí hoàn thành:
- `ng build` sạch lỗi.
- Login: điền định danh → F5 → còn nguyên; mật khẩu trống.
- Đăng nhập thành công → cả hai key nháp biến mất.
- Chạy lại toàn bộ test của Phase 1 vẫn pass (hồi quy).

Test case dự kiến:
- Unit test: hai khoá login/register độc lập nhau; `clearAll()` xoá đúng cả hai; xoá khoá không
  tồn tại không throw.
- E2E Playwright: gõ định danh ở `/login` → reload → còn giá trị, mật khẩu rỗng; đăng nhập thành
  công bằng tài khoản test → assert localStorage sạch cả hai khoá.

### Kết quả Phase 2
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend `<không có thay đổi>`
- Kết quả test: unit test `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** —
  - [ ] **Feature** —
  - [ ] **Data** —
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Nhật ký duyệt & hoàn thành
| Phase | Duyệt lúc | Hoàn thành lúc | Test pass | Commit |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |

---

## Ghi chú về git (cần mentor chốt trước Bước 7)

Skill quy định nhánh dạng `pages/<ten-trang>/<ten-member>`, và `features/auth/**` thuộc **Mon**
theo bảng ownership. Người thực hiện đợt này là **mentor Luke**, không nằm trong bảng phân công,
nên tên nhánh chưa suy ra được tự động. Cả hai repo hiện đang ở `main`, mà skill cấm push thẳng
vào `main`. Ba lựa chọn, chốt trước khi commit:

1. `pages/auth/mon` — coi như làm hộ phần của Mon, sau này Mon commit tiếp lên cùng nhánh.
2. `pages/auth/luke` — nhánh riêng của mentor, không đụng vào nhánh của Mon.
3. Nhánh khác do mentor chỉ định.

## Tổng kết trang (điền ở Bước 9 — chỉ sau khi xong tất cả phase)
- Ngày hoàn thành trang:
- Tổng số phase đã làm:
- Kết quả hồi quy toàn bộ: unit `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá tổng thể theo 3 tiêu chí:
  - **UI/UX**:
  - **Feature**:
  - **Data**:
- Migration DB đã dùng trong trang: không có.
- Phần còn thiếu / để lại cho sau:
- PR cuối cùng:
