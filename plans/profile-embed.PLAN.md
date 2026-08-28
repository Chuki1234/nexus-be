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
- Commit: frontend `n/a` · backend `0fd93b6`
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
Status: DONE

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
- Ngày hoàn thành: 2026-08-29
- Commit: frontend `3f95a36` · backend `n/a`
- Kết quả test: unit `internal-link 19/19 · chat-link-embed 4/4 · conversation 65/65 (compile+render OK)` ·
  E2E Playwright `hoãn` (xem ghi chú)
- Đánh giá theo 3 tiêu chí:
  - [x] **UI/UX** — tái dùng `app-profile-preview-card` (đồng bộ thẻ Setting), nút "Xem hồ sơ"
    `mat-stroked-button` + `mat-icon`, có skeleton khi loading, fallback ẩn card khi không có hồ sơ
  - [x] **Feature** — dữ liệu live qua `ProfileLookupService` (cache/dedupe), tôn trọng quyền xem
    (lookup null → ẩn card, link inline còn nguyên); link NGOÀI giữ nguyên placeholder cũ (2 block)
  - [x] **Data** — đi qua NestJS (`ProfileLookupService` → `/api/profiles/:username`), không query Supabase thẳng
- Migration DB: chưa cần
- Vấn đề phát sinh / ghi chú:
  1) Phát hiện `@ngx-translate/core` bị THIẾU khai trong `package.json` (20 file import, cả `profile-preview-card`)
     → build toàn FE fail. Đã cài `@ngx-translate/core@16.0.4` (khớp API `provideTranslateService`, peer Angular >=16)
     và thêm vào `package.json`. Đây là lỗi dependency pre-existing, không do feature.
  2) FE working tree đang có WIP CHƯA COMMIT của người khác đang hỏng biên dịch — `user-panel.ts/.html`
     (thiếu import Material) + file mới `account-switch.service.ts`, `features/profile/modals/` — làm
     dev-server build (full app) fail. KHÔNG đụng/commit các file này. Vì builder unit-test chạy graph-scoped
     nên test của feature vẫn xanh; nhưng browser/E2E verify HOÃN tới khi WIP đó compile lại. Cần báo chủ WIP.
- PR: FE Chuki1234/nexus-fe#37
---

## Phase 4: Embed SERVER (invite + introduction) + nút hành động
Status: DONE

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
- Ngày hoàn thành: 2026-08-29
- Commit: frontend `cc1959f` · backend `n/a`
- Kết quả test: unit `chat-link-embed 7/7 · servers-api 15/15 · conversation 65/65` · E2E Playwright `hoãn` (xem ghi chú)
- Đánh giá theo 3 tiêu chí:
  - [x] **UI/UX** — card máy chủ (icon/tên/số thành viên) đồng bộ token; nút `mat-flat-button` +
    `mat-icon`: "Tham gia" (invite) / "Xem server" (introduction); skeleton khi tải; invite hết hạn/hết
    lượt → chặn nút + hiện lý do
  - [x] **Feature** — invite `/invite/:code` → `getInvitePreview` + nút Tham gia; introduction
    `/channels/:serverId` → `getServerPreview` + nút Xem server; cache dedupe tĩnh (nhiều tin cùng link
    chỉ 1 request); lỗi/không tồn tại → ẩn card, link inline còn nguyên
  - [x] **Data** — `getServerPreview` gọi endpoint public, KHÔNG gắn Authorization header; mọi data qua NestJS
- Migration DB: chưa cần
- Vấn đề phát sinh / ghi chú: browser/E2E verify VẪN hoãn (như Phase 3) do WIP chưa commit của người khác
  (`user-panel.ts/.html` + `account-switch.service.ts` + `features/profile/modals/`) làm full app build fail.
  Không đụng các file đó; unit test (graph-scoped) đã phủ đủ cả 3 loại link.
- PR: FE Chuki1234/nexus-fe#37

## Phase 5: Tương tác card — bỏ nút "xem chi tiết", click vào tên
Status: DONE

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **UI/UX**: BỎ nút "Xem hồ sơ" ở card user và nút "Xem server" ở card introduction. Tên (displayName /
  server name) trở thành phần bấm được, **hover → gạch dưới**. Giữ nút "Tham gia" cho card invite.
- **Feature**: click tên USER → mở **dialog preview hồ sơ** qua `ProfileDialogService.open(username, profile)`
  (truyền profile đã load để không refetch). Click tên SERVER (introduction/invite) → điều hướng
  `/channels/:serverId`. Link ngoài không đổi.

File/folder dự kiến:
- frontend:
  - `src/app/shared/ui/profile-card/profile-preview-card.component.ts` (HẠ TẦNG DÙNG CHUNG — thêm input
    `nameInteractive` + output `nameClick`, style hover gạch dưới; mặc định false để trang Setting không đổi)
  - `src/app/features/dashboard/conversation/components/chat-link-embed/chat-link-embed.{ts,html,spec.ts}`
    (inject `ProfileDialogService`, wire `nameClick`, bỏ nút, server name → routerLink)
  - `playwright.config.ts` + `e2e/chat-link-embed.e2e.ts` (setup Playwright + E2E 4 luồng)
- backend: (không)

Tiêu chí hoàn thành:
- User card không còn nút; click tên mở dialog; hover gạch dưới. Server card introduction: tên → điều hướng,
  không còn nút "Xem server"; invite giữ "Tham gia".
- Trang Setting (dùng `profile-preview-card`) KHÔNG đổi hành vi (nameInteractive mặc định false).

Test case dự kiến:
- Unit: chat-link-embed — click tên user gọi `ProfileDialogService.open`; không còn nút "Xem hồ sơ";
  server introduction tên có routerLink `/channels/:id`.
- E2E (Playwright): dán /u/:username → card → click tên → dialog hiện; link ngoài → không embed.

### Kết quả Phase 5
- Ngày hoàn thành: 2026-08-29
- Commit: frontend `d5c7cd7` · backend `n/a`
- Kết quả test: unit `chat-link-embed 6/6 · servers-api 15/15 · conversation 65/65 · internal-link 19/19`
  (regression 105/105) · E2E `3 test đã author` (playwright.config.ts + e2e/chat-link-embed.e2e.ts) —
  chạy cần `npx playwright install` + storageState đăng nhập
- Đánh giá theo 3 tiêu chí:
  - [x] **UI/UX** — bỏ nút "Xem hồ sơ"/"Xem server"; tên hover → gạch dưới; user click tên → dialog,
    server click tên → điều hướng; invite giữ nút "Tham gia"
  - [x] **Feature** — `ProfileDialogService.open(username)` cho user; server name `routerLink`
    (/channels/:id hoặc /invite/:code); invite hết hạn → không cho tham gia + lý do
  - [x] **Data** — không đổi (dùng dữ liệu đã load)
- Migration DB: chưa cần
- Vấn đề phát sinh / ghi chú: (1) sửa HẠ TẦNG DÙNG CHUNG `profile-preview-card` — thêm input
  `nameInteractive` + output `nameClick`, mặc định false nên trang Setting KHÔNG đổi. (2) Cài
  `@playwright/test` + script `e2e`. (3) Visual live cần đăng nhập → agent không tự nhập credential được,
  đã phủ bằng unit + author E2E để người dùng chạy.
- PR: FE Chuki1234/nexus-fe#37
---

## Phase 6: Làm giàu card server như ảnh mock (description / tags / online / founding date)
Status: APPROVED

Mục tiêu (gắn với 1+ trong 3 tiêu chí UI/UX - Feature - Data):
- **Data**: card server hiển thị như mock — mô tả, tags, số Trực tuyến, "Thành lập từ" (created_at). Cần
  DỮ LIỆU MỚI: thêm cột `description text` và `tags text[]` vào bảng `servers`; endpoint preview trả thêm
  `description`, `tags`, `createdAt`, `onlineCount`.
- **UI/UX**: card server = icon + tên (clickable) + "N Trực tuyến · M thành viên" + "Thành lập từ …" +
  mô tả (hoặc placeholder "Chưa có mô tả…") + hàng tag chip.

File/folder dự kiến:
- backend:
  - `backend/migrations/<timestamp>_add_server_description_tags.sql` (ALTER TABLE servers ADD description, tags)
    — **mentor Luke áp trên Supabase**, chờ xác nhận rồi mới nối code.
  - `src/modules/servers/servers.service.ts` (getServerPreview: select thêm description/tags/created_at;
    onlineCount từ presence — cần xác định nguồn presence, có thể tách nhỏ)
  - `src/shared/dto/server-invitations.dto.ts` (ServerPreviewDto: thêm description/tags/createdAt/onlineCount) — mirror FE↔BE
- frontend:
  - `src/app/core/api/servers-api.service.ts` (kiểu trả mới)
  - `chat-link-embed.{ts,html,spec.ts}` (UI card server giàu + tag chips)

Tiêu chí hoàn thành:
- Endpoint trả đủ field mới; card render như mock; không lộ field nhạy cảm.
- onlineCount đúng nguồn presence (nếu chưa sẵn → ghi "chờ" và tạm ẩn, không chặn phần còn lại).

Test case dự kiến:
- Unit: getServerPreview trả field mới; servers-api map đúng; chat-link-embed render tags/mô tả/founding date.
- E2E (Playwright): dán /channels/:id → card giàu hiện đủ mục.

### Kết quả Phase 6
- Ngày hoàn thành:
- Commit: frontend `<sha>` · backend `<sha>`
- Kết quả test: unit `<x/y>` · E2E `<x/y>`
- Đánh giá theo 3 tiêu chí:
  - [ ] **UI/UX** — card giàu như mock
  - [ ] **Feature** — đủ field, tag chips
  - [ ] **Data** — migration áp đúng, không lộ field nhạy cảm, onlineCount đúng nguồn
- Migration DB: `nexus-be/supabase/migrations/20260829120000_server_description_tags.sql` (thêm cột
  `description` + `tags` vào bảng `servers`) — trạng thái: ĐÃ TẠO, **chờ mentor áp trên Supabase**. Sau
  khi mentor xác nhận mới nối code (DTO/service/UI). `onlineCount` lấy từ `PresenceService` ở bước code.
- Vấn đề phát sinh / ghi chú:
- PR: FE #37 · BE #26

---

## Nhật ký duyệt & hoàn thành (bảng tóm tắt nhanh — chi tiết xem mục "Kết quả Phase N" ở trên)
| Phase | Duyệt lúc | Hoàn thành lúc | Test pass | Commit |
| --- | --- | --- | --- | --- |
| 1 | 2026-08-28 | 2026-08-28 | unit 19/19 | fe a2511af · be c4bbe52 |
| 2 | 2026-08-28 | 2026-08-28 | unit 6/6 | be 0fd93b6 |
| 3 | 2026-08-29 | 2026-08-29 | unit 19+4+65 | fe 3f95a36 |
| 4 | 2026-08-29 | 2026-08-29 | unit 7+15+65 | fe cc1959f |
| 5 | 2026-08-29 | 2026-08-29 | unit 105/105 | fe d5c7cd7 |
| 6 | | | | |

---

## Tổng kết trang (điền ở Bước 9 — CHỈ SAU KHI đã xong tất cả phase, trước khi bàn giao mentor)
- Ngày hoàn thành trang: 2026-08-29
- Tổng số phase đã làm: 4/4 (DONE)
- Kết quả hồi quy toàn bộ: FE unit `106/106` (internal-link 19 · chat-link-embed 7 · servers-api 15 ·
  conversation 65) · BE unit `6/6` (server-preview) · E2E Playwright `HOÃN` (xem phần còn thiếu)
- Đánh giá tổng thể theo 3 tiêu chí cho TOÀN BỘ feature:
  - **UI/UX**: card hồ sơ tái dùng `app-profile-preview-card` + card máy chủ (icon/tên/số thành viên)
    đồng bộ design token; nút hành động dùng Angular Material (`mat-stroked/flat-button` + `mat-icon`);
    có loading skeleton, fallback ẩn card, trạng thái invite hết hạn. CHƯA verify trực quan trên trình
    duyệt (build full app bị chặn bởi WIP người khác — xem dưới).
  - **Feature**: 3 loại URL nội bộ same-origin render đúng — hồ sơ `/u/:username`, lời mời `/invite/:code`
    (nút Tham gia), giới thiệu `/channels/:serverId` (nút Xem server); dữ liệu live + cache dedupe; tôn
    trọng quyền xem (không thấy → ẩn card); link NGOÀI giữ nguyên placeholder cũ (không áp dụng embed).
  - **Data**: mọi data qua NestJS (LUẬT CỨNG #1) — hồ sơ qua `/api/profiles/:username`, server qua
    `/api/invites/:code` và endpoint mới `/api/servers/:id/preview` (public, validate uuid, 400/404, chỉ
    field công khai, không lộ owner_id, đếm member head:true). DTO `ServerPreviewDto` mirror FE↔BE.
- Migration DB đã dùng: không có (dùng bảng `servers` + `server_members` có sẵn).
- Phần còn thiếu / để lại cho sau:
  1) **Verify trực quan browser + E2E Playwright**: HOÃN vì FE working tree có WIP CHƯA COMMIT của người
     khác đang lỗi biên dịch (`layouts/.../user-panel/user-panel.ts/.html` thiếu import Material + file mới
     `core/auth/account-switch.service.ts`, `features/profile/modals/`) làm dev-server build cả app fail.
     Unit test (graph-scoped) đã phủ đủ. Khi WIP đó compile lại → chạy dev server verify + viết E2E.
  2) Đã CÀI thiếu dependency `@ngx-translate/core@16.0.4` vào `package.json` (20 file import nó nhưng chưa
     khai — pre-existing, chặn build toàn FE).
  3) 2 spec cũ `servers.service.spec.ts` / `servers.controller.spec.ts` (trang Minh Tài) đỏ sẵn từ baseline
     do constructor drift — đã tách test feature ra file riêng, KHÔNG sửa; có task riêng để Minh Tài xử lý.
- PR cuối cùng: FE Chuki1234/nexus-fe#37 · BE Chuki1234/nexus-be#26
