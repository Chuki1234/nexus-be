# Kế hoạch triển khai: Profile Embed trong khung chat

- Project: Nexus
- Member: Luke (mentor — tự làm cross-page, override ownership của Minh Tài cho Dashboard + servers module)
- Nhánh git: feature/profile-embed
- Ngày tạo: 2026-08-28

## Tổng quan
Khi một URL **nội bộ Nexus** được dán vào khung chat, thay vì chỉ hiển thị link xanh + card
placeholder "Xem trước liên kết web", hệ thống render thành **card snapshot** giống thẻ preview
profile trong Setting. Dữ liệu **live + cache** (fetch khi render, nhớ kết quả), có **nút hành
động**.

Ba loại URL nội bộ hỗ trợ (same-origin):
1. **User profile** — `origin/u/:username` → tái dùng `app-profile-preview-card` (bản canonical
   đã có), nút "Xem hồ sơ".
2. **Server invite** — `origin/invite/:code` → dùng API public sẵn có `GET /api/invites/:code`,
   card server + nút "Tham gia".
3. **Server introduction** — `origin/channels/:serverId` → **cần endpoint backend mới**
   `GET /api/servers/:id/preview` (public), card server + nút "Xem server".

**KHÔNG trong scope lần này:** link ngoài (external) — giữ nguyên hành vi hiện tại (link inline
+ placeholder cũ). Không đổi schema DB (bảng `servers`, `server_members` đã đủ). Không snapshot
đông cứng dữ liệu vào bảng `messages`.

**Ownership:** Luke (mentor) chủ động làm, override luật cách ly. Có chạm:
- `features/dashboard/conversation/*` (Minh Tài) — chỉ swap block link-preview + thêm import.
- backend `modules/servers/*` (Minh Tài) — thêm 1 read endpoint public, không sửa logic có sẵn.
- `shared/` (dùng chung) — thêm 1 DTO.
- `shared/ui/profile-card`, `core/profile` (Luke/shared) — chỉ tái dùng, không sửa.

---

## Phase 1: Util nhận diện link nội bộ + Shared DTO
Status: DONE 

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **Feature**: util `resolveInternalLink(url)` nhận diện đúng 3 loại URL nội bộ same-origin
  (`/u/:username`, `/invite/:code`, `/channels/:serverId`), trả `null` cho link ngoài và mọi
  URL không khớp — không nhận nhầm `/channels/:serverId/:channelId` thành server.
- **Data**: định nghĩa `ServerPreviewDto` trong `shared/` (mirror FE↔BE) làm hợp đồng dữ liệu
  cho endpoint ở Phase 2.

File/folder dự kiến:
- frontend:
  - `src/app/features/dashboard/conversation/utils/internal-link.ts` (mới)
  - `src/app/features/dashboard/conversation/utils/internal-link.spec.ts` (mới)
  - `src/shared/dto/server-invitations.dto.ts` (thêm `ServerPreviewDto`)
- backend:
  - `src/shared/dto/server-invitations.dto.ts` (mirror `ServerPreviewDto` — giống hệt FE)

Tiêu chí hoàn thành (Definition of Done):
- Util chỉ khớp same-origin (`new URL().origin === location.origin`); regex path chặt.
- `ServerPreviewDto` xuất hiện ở barrel `shared/index.ts` cả 2 repo, `npm run check:shared` sạch.
- Unit test phủ: 3 loại hợp lệ, link ngoài, `/channels/:id/:channelId`, URL rác.

Test case dự kiến:
- Unit test: `internal-link.spec.ts` — bảng case cho từng loại + null.
- E2E / workflow test (Playwright): (chưa — Phase 1 thuần logic, không UI)

### Kết quả Phase 1
- Ngày hoàn thành: 2026-08-28
- Commit: frontend `a2511af` · backend `c4bbe52`
- Kết quả test: unit test `19/19 pass` (internal-link.spec.ts) · E2E Playwright `n/a`
- Đánh giá theo 3 tiêu chí:
  - [x] **UI/UX** — n/a (phase logic thuần, chưa có UI)
  - [x] **Feature** — `resolveInternalLink` nhận đúng /u/:username, /invite/:code,
    /channels/:serverId (uuid); loại trừ link ngoài, /channels/:id/:channelId, /channels/@me,
    URL rác. 19 case pass.
  - [x] **Data** — `ServerPreviewDto` thêm vào shared, mirror FE↔BE khớp (`check:shared` sạch, 12 file)
- Migration DB: chưa cần
- Vấn đề phát sinh / ghi chú: util nhận `origin` qua tham số (mặc định `location.origin`) để test
  không phụ thuộc môi trường trình duyệt; chỉ khớp same-origin nên link ngoài an toàn tuyệt đối.
- PR: FE Chuki1234/nexus-fe#37 · BE Chuki1234/nexus-be#26

---

## Phase 2: Backend endpoint GET /api/servers/:id/preview (public)
Status: DONE

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **Data**: `GET /api/servers/:serverId/preview` trả `ServerPreviewDto` (id, name, iconUrl,
  bannerUrl, memberCount) — validate `serverId` là uuid (400 nếu sai), 404 khi server không
  tồn tại, **chỉ trả field công khai an toàn** (không owner_id, không dữ liệu nhạy cảm), không
  để lỗi 500 chung chung.
- **Feature**: endpoint public (không cần đăng nhập) như `GET /api/invites/:code`, để người
  nhận chưa ở trong server vẫn xem được card giới thiệu.

File/folder dự kiến:
- frontend: (không)
- backend:
  - `src/modules/servers/servers.service.ts` (thêm `getServerPreview()`)
  - `src/modules/servers/servers.controller.ts` (thêm public controller/route cho preview)
  - `src/modules/servers/servers.module.ts` (đăng ký controller nếu tách class mới)
  - `src/modules/servers/*.spec.ts` (unit test service + controller)

Tiêu chí hoàn thành:
- Route trả đúng DTO cho server tồn tại; 400 khi id không phải uuid; 404 khi không có server.
- Không nằm dưới guard auth (giống InvitesController) — gọi được khi chưa đăng nhập.
- Không N+1: 1 query lấy server + 1 count member (head:true), giống `getInvitePreview`.

Test case dự kiến:
- Unit test (Jest): `getServerPreview` trả DTO đúng; ném `BadRequestException` khi id rác;
  ném `NotFoundException` khi maybeSingle trả null; controller gọi service đúng tham số.
- E2E / workflow test (Playwright): (chưa — verify bằng unit + gọi thử ở Phase 4)

### Kết quả Phase 2
- Ngày hoàn thành: 2026-08-28
- Commit: frontend `n/a` · backend `<điền sau khi push>`
- Kết quả test: unit test `6/6 pass` (server-preview.spec.ts) · `nest build` sạch
- Đánh giá theo 3 tiêu chí:
  - [x] **UI/UX** — n/a (backend)
  - [x] **Feature** — endpoint public `GET /api/servers/:serverId/preview` (ServerPreviewController,
    không guard) hoạt động cho cả khách chưa đăng nhập; delegate về ServersService.getServerPreview
  - [x] **Data** — validate uuid (400), 404 khi không có server, chỉ trả field công khai
    (serverId/name/iconUrl/bannerUrl/memberCount), không lộ owner_id; đếm member bằng head:true (không N+1)
- Migration DB: chưa cần (dùng bảng servers + server_members có sẵn)
- Vấn đề phát sinh / ghi chú: khi viết test phát hiện 2 spec CŨ của Minh Tài đã hỏng sẵn từ baseline
  do constructor drift — `servers.service.spec.ts` thiếu provider `MediaService`,
  `servers.controller.spec.ts` thiếu `ServerRolesService`. KHÔNG sửa (thuộc trang Minh Tài); thay
  vào đó tách test feature sang file mới độc lập `server-preview.spec.ts` (khởi tạo bằng `new`, không
  qua Nest DI) để không đụng vùng người khác. Nên báo Minh Tài 2 spec này đang đỏ.
- PR: BE Chuki1234/nexus-be#26
---

## Phase 3: Embed USER profile + ghép vào khung chat
Status: PENDING

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **UI/UX**: dán link `origin/u/:username` → hiện card snapshot dùng lại
  `app-profile-preview-card` (đúng Design System, cùng thẻ với Setting), có trạng thái
  loading (skeleton) / lỗi-không-thấy (ẩn card, giữ link inline), nút "Xem hồ sơ" bằng
  `mat-button` + `mat-icon`.
- **Feature**: dữ liệu live qua `ProfileLookupService` (có cache/dedupe sẵn); tôn trọng quyền
  xem (không thấy → 404 → fallback link thường); chỉ áp dụng cho link nội bộ, link ngoài giữ
  nguyên placeholder cũ.

File/folder dự kiến:
- frontend:
  - `src/app/features/dashboard/conversation/components/chat-link-embed/` (mới, tạo bằng
    `ng g c`) — container nhận `url`, resolve kind, nhánh `profile` trước.
  - `src/app/features/dashboard/conversation/conversation.ts` (thêm import + helper resolve)
  - `src/app/features/dashboard/conversation/conversation.html` (thay block `displayLinkPreviews`:
    internal → `<app-chat-link-embed>`, external → giữ placeholder cũ)
- backend: (không)

Tiêu chí hoàn thành:
- Link user nội bộ render card đúng người; link ngoài KHÔNG đổi hành vi.
- Có loading + fallback; không vỡ layout; không hardcode màu ngoài token.

Test case dự kiến:
- Unit test: (component nhẹ — test resolve nhánh + fallback nếu khả thi)
- E2E / workflow test (Playwright): gửi tin có link `/u/:username` → thấy card + tên/username;
  gửi link ngoài → không có card mới.

### Kết quả Phase 3
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend `<n/a>`
- Kết quả test: unit `<x/y>` · E2E Playwright `<x/y>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — reuse preview-card, Material button/icon, loading/error đủ
  - [ ] **Feature** — live+cache, tôn trọng quyền xem, không đụng link ngoài
  - [ ] **Data** — dùng API qua NestJS (không query thẳng Supabase)
- Migration DB: chưa cần
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Phase 4: Embed SERVER (invite + introduction) + nút hành động
Status: PENDING

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **Feature**: mở rộng `chat-link-embed` xử lý `server-invite` (dùng
  `ServersApiService.getInvitePreview`) và `server` (thêm `getServerPreview` gọi endpoint
  Phase 2). Nút "Tham gia" (invite) / "Xem server" (introduction).
- **UI/UX**: card server (icon + tên + số thành viên) đồng bộ Design System, loading/error,
  `mat-icon`.

File/folder dự kiến:
- frontend:
  - `src/app/core/api/servers-api.service.ts` (thêm `getServerPreview(serverId)`)
  - `src/app/features/dashboard/conversation/components/chat-link-embed/*` (thêm nhánh server)
- backend: (không — endpoint đã xong Phase 2)

Tiêu chí hoàn thành:
- 2 loại link server render card đúng; nút hành động điều hướng đúng (`/invite/:code`,
  `/channels/:serverId`).
- Invite hết hạn / max-used → hiện trạng thái phù hợp (dựa `status` của DTO), không lỗi.

Test case dự kiến:
- Unit test: `servers-api.service.spec.ts` — `getServerPreview` gọi đúng URL.
- E2E / workflow test (Playwright): gửi link `/invite/:code` và `/channels/:serverId` →
  thấy card server + nút.

### Kết quả Phase 4
- Ngày hoàn thành:
- Commit: frontend `<sha ngắn>` · backend `<n/a>`
- Kết quả test: unit `<x/y>` · E2E Playwright `<x/y>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — card server đồng bộ, Material, loading/error
  - [ ] **Feature** — invite + introduction đúng hành vi, nút điều hướng đúng
  - [ ] **Data** — endpoint preview trả field an toàn, xử lý invite hết hạn
- Migration DB: chưa cần
- Vấn đề phát sinh / ghi chú:
- PR:

---

## Nhật ký duyệt & hoàn thành (bảng tóm tắt nhanh — chi tiết xem mục "Kết quả Phase N" ở trên)
| Phase | Duyệt lúc | Hoàn thành lúc | Test pass | Commit |
| --- | --- | --- | --- | --- |
| 1 | 2026-08-28 | 2026-08-28 | unit 19/19 | fe a2511af · be c4bbe52 |
| 2 | 2026-08-28 | 2026-08-28 | unit 6/6 | be (điền sau) |
| 3 | | | | |
| 4 | | | | |

---

## Tổng kết trang (điền ở Bước 9 — CHỈ SAU KHI đã xong tất cả phase, trước khi bàn giao mentor)
- Ngày hoàn thành trang:
- Tổng số phase đã làm:
- Kết quả hồi quy toàn bộ: unit `<x/y pass>` · E2E Playwright `<x/y pass>`
- Đánh giá tổng thể theo 3 tiêu chí cho TOÀN BỘ feature:
  - **UI/UX**:
  - **Feature**:
  - **Data**:
- Migration DB đã dùng: không có
- Phần còn thiếu / để lại cho sau:
- PR cuối cùng:
