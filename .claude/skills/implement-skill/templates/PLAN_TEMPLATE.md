# Kế hoạch triển khai: <Tên trang>

- Project: <Nexus | Fizzle>
- Member: <Tên member>
- Nhánh git: pages/<ten-trang>/<ten-member> <!-- điền chính xác sau khi nhánh được tạo ở Phase 1, Bước 7 của SKILL.md -->
- Ngày tạo: <YYYY-MM-DD>

## Tổng quan
<Mô tả ngắn scope của trang trong phiên làm việc này, tham chiếu Feature + Core stack từ reference/plan-nexus.md hoặc reference/plan-fizzle.md. Nêu rõ những gì KHÔNG nằm trong scope lần này nếu trang lớn phải chia nhiều đợt.>

---

## Phase 1: <tên ngắn gọn của phase>
Status: PENDING <!-- member tự sửa thành APPROVED sau khi đọc và đồng ý; agent chỉ code khi thấy đúng chữ APPROVED ở dòng này -->

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- <mục tiêu cụ thể, đo được, ghi rõ thuộc tiêu chí nào>

File/folder dự kiến:
- frontend: <đường dẫn cụ thể sẽ tạo/sửa>
- backend: <đường dẫn cụ thể sẽ tạo/sửa>

Tiêu chí hoàn thành (Definition of Done):
- <tiêu chí 1>
- <tiêu chí 2>

Test case dự kiến:
- Unit test: <mô tả>
- E2E / workflow test (Playwright): <mô tả>

### Kết quả Phase 1 <!-- agent điền phần này SAU KHI test xong ở Bước 6, ngay trước khi commit ở Bước 7 — đây là bản ghi phiên bản/kết quả, không được bỏ trống khi đánh dấu DONE -->
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend `<sha ngắn>`
- Kết quả test: unit test `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — follow file Design System của repo? component chính dùng Angular Material (shared/ui wrap lại)? icon dùng mat-icon + Google Fonts? đủ loading/empty/error? <ghi chú>
  - [ ] **Feature** — đối chiếu feature liên quan trong reference/plan-*.md, đã đúng hành vi chưa? <ghi chú>
  - [ ] **Data** — DTO/validate đủ chưa? có lộ field nhạy cảm không? mã lỗi HTTP đúng chưa? <ghi chú>
- Migration DB (nếu phase cần bảng/cột mới): file `backend/migrations/<...>.sql` đã tạo? đã gửi mentor? mentor đã tạo bảng chưa? <trạng thái: chưa cần / chờ mentor / đã tạo xong>
- Vấn đề phát sinh / ghi chú:
- PR: <link hoặc số PR>

---

## Phase 2: <tên ngắn gọn của phase>
Status: PENDING

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- ...

File/folder dự kiến:
- frontend: ...
- backend: ...

Tiêu chí hoàn thành:
- ...

Test case dự kiến:
- Unit test: ...
- E2E / workflow test (Playwright): ...

### Kết quả Phase 2
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend `<sha ngắn>`
- Kết quả test: unit test `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — <ghi chú>
  - [ ] **Feature** — <ghi chú>
  - [ ] **Data** — <ghi chú>
- Vấn đề phát sinh / ghi chú:
- PR: <link — thường trùng PR của Phase 1 vì cùng 1 nhánh>

---

<!-- Thêm Phase 3, 4... theo cùng mẫu (mục tiêu + Kết quả) nếu cần. Mỗi phase nên đủ nhỏ để làm + test + commit trong một buổi. -->

## Nhật ký duyệt & hoàn thành (bảng tóm tắt nhanh — chi tiết xem mục "Kết quả Phase N" ở trên)
| Phase | Duyệt lúc | Hoàn thành lúc | Test pass | Commit |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |

---

## Tổng kết trang (điền ở Bước 9 — CHỈ SAU KHI đã xong tất cả phase, trước khi bàn giao mentor)
- Ngày hoàn thành trang:
- Tổng số phase đã làm:
- Kết quả hồi quy toàn bộ (chạy lại hết test của mọi phase): unit `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá tổng thể theo 3 tiêu chí cho TOÀN BỘ trang:
  - **UI/UX**: <follow Design System + Angular Material + mat-icon/Google Fonts; đạt / còn thiếu gì>
  - **Feature**: <đối chiếu đủ danh sách feature của trang trong reference/plan-*.md, feature nào chưa làm nếu có>
  - **Data**: <đạt / còn thiếu gì>
- Migration DB đã dùng trong trang (liệt kê các file `backend/migrations/*.sql` + trạng thái mentor đã tạo bảng chưa):
- Phần còn thiếu / để lại cho sau (nếu có, được phép bàn giao dù chưa 100% miễn ghi rõ):
- PR cuối cùng: <link>
