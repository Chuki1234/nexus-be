# Nexus (lớp 246) — tóm tắt để agent tra cứu

Nguồn gốc: file `plan_246` do mentor Luke cung cấp. File này chỉ tóm tắt phần agent cần để xác định danh tính member và phạm vi trang — khi cần chi tiết Feature/Workflow đầy đủ, hỏi member hoặc xin mentor gửi lại file `plan_246` gốc.

## Techstack
Angular 21 · NestJS · Supabase

Cây thư mục thật (client + server) + bảng ownership chi tiết nằm ở
`reference/folder-structure-nexus-client.md` và `reference/folder-structure-nexus-server.md`.

## Bảng phân công (Members) — dùng để tra tên nhánh git ra trang được giao

| Tên member | Trang phụ trách | Tên trang chuẩn hoá (kebab-case, khớp tên folder trong `features/`/`modules/`) | Nhánh git (tự tạo — xem SKILL.md Bước 7) |
| --- | --- | --- | --- |
| Mon | Auth pages (Login/Register/Quên mật khẩu) | `auth` | `pages/auth/mon` |
| Minh Tài | Dashboard | `dashboard` | `pages/dashboard/minh-tai` |
| Triều Dược | Profile page | `profile` | `pages/profile/trieu-duoc` |
| Trường Giang | Setting page | `settings` | `pages/settings/truong-giang` |

Không cần mentor tạo nhánh trước — agent tự tạo đúng 1 lần khi bắt đầu Phase 1 của trang (chi
tiết ở SKILL.md Bước 7), các phase sau chỉ commit/push tiếp lên nhánh đã có.

Lưu ý khi so khớp tên: tên nhánh git thường bị bỏ dấu / viết thường / nối bằng dấu gạch ngang (vd `minh-tai`, `truong-giang`). So khớp không phân biệt hoa thường và bỏ qua dấu tiếng Việt.

## Mô tả nhanh từng trang (để lập plan sát đúng scope)

**auth (Login/Register/Quên mật khẩu)**
- Feature: đăng nhập (email hoặc SĐT), đăng ký, quên tài khoản.
- Core stack: Supabase Auth (JWT, Refresh Token, OAuth), Angular Reactive Forms + Zod/class-validator, HTTP-only cookie, NestJS Throttler chống brute-force.

**dashboard**
- Feature: nhắn tin cá nhân (gửi/sửa/xoá, sticker, file attachment, xem lại file đã gửi), tạo Server (cá nhân/nhóm), tạo Channel, phân biệt các server, tìm kiếm, thêm bạn, hiển thị trạng thái (online/mic/tai nghe), hiển thị thông báo.
- Core stack: Socket.IO (`@nestjs/websockets` + `socket.io-client`), WebRTC (PeerJS/LiveKit/Mediasoup) cho voice/video, Supabase PostgreSQL + Redis (session/presence), Supabase Storage/S3 cho file, NgRx hoặc Signals cho state.

**profile**
- Feature: xem profile bản thân/bạn bè, chỉnh sửa profile (thông tin, avatar, banner, status message).
- Core stack: Supabase Storage (upload/resize avatar/banner), NestJS REST API + DTO validation.

**setting**
- Feature: setting account (thông tin cá nhân, đổi ngôn ngữ, đăng xuất, tuỳ chỉnh thông báo, đổi mật khẩu, 2FA), setting server (profile server, quyền truy cập, phân quyền, mời), setting channel (tương tự cấp channel).
- Core stack: `@ngx-translate/core`, NestJS Guards + CASL/RBAC, Nanoid/Short UUID cho invite link (TTL qua Supabase).

**AI agent (optional, không thuộc phân công cố định — chỉ làm nếu mentor/member yêu cầu thêm)**
- Feature: tóm tắt channel, AI assistant chat, phát hiện spam/link lừa đảo.
- Core stack: OpenAI/Gemini API, LangChainJS, NestJS BullMQ + Redis cho background job.

## Timeline tham khảo (không phải quy trình bắt buộc của skill — chỉ để hiểu bối cảnh)
4 tuần (20/07–16/08): Tuần 1 Auth & setup, Tuần 2 Realtime chat & DM, Tuần 3 Server/Channel/quyền/voice, Tuần 4 AI agent + Setting + Test + Deploy.
