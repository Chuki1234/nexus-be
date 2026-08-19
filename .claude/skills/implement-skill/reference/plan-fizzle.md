# Fizzle (lớp 357) — tóm tắt để agent tra cứu

Nguồn gốc: file `plan_357` do mentor Luke cung cấp. File này chỉ tóm tắt phần agent cần để xác định danh tính member và phạm vi trang — khi cần chi tiết Feature/Workflow đầy đủ, hỏi member hoặc xin mentor gửi lại file `plan_357` gốc.

## Techstack
Angular 21 · NestJS · Supabase

Cây thư mục thật (client + server, do mentor gửi) + bảng ownership chi tiết nằm ở
`reference/folder-structure-fizzle-client.md` và `reference/folder-structure-fizzle-server.md`.

## Bảng phân công (Members) — dùng để tra tên nhánh git ra trang được giao

| Tên member | Trang phụ trách | Tên trang chuẩn hoá (kebab-case, khớp tên folder trong `features/`/`modules/`) | Nhánh git (tự tạo — xem SKILL.md Bước 7) |
| --- | --- | --- | --- |
| Thiện Phúc | Dashboard | `dashboard` | `pages/dashboard/thien-phuc` |
| Hoàng Khang | Profile, Setting | `profile`, `settings` | `pages/profile/hoang-khang`, `pages/settings/hoang-khang` (2 trang → 2 nhánh riêng, mỗi trang 1 PR) |
| Khánh Hưng | Login, Livestream | `auth`, `livestream` | `pages/auth/khanh-hung`, `pages/livestream/khanh-hung` (2 trang → 2 nhánh riêng, mỗi trang 1 PR) |

Không cần mentor tạo nhánh trước — agent tự tạo đúng 1 lần cho mỗi trang khi bắt đầu Phase 1
(chi tiết ở SKILL.md Bước 7), các phase sau chỉ commit/push tiếp lên nhánh đã có.

Lưu ý khi so khớp tên: tên nhánh git thường bị bỏ dấu / viết thường / nối bằng dấu gạch ngang (vd `thien-phuc`, `hoang-khang`). So khớp không phân biệt hoa thường và bỏ qua dấu tiếng Việt.

## Mô tả nhanh từng trang (để lập plan sát đúng scope)

**auth (Login/Register/Quên mật khẩu)**
- Feature: đăng nhập (email/SĐT), đăng ký (có xác thực OTP/email), quên mật khẩu, 2FA.
- Core stack: Supabase Auth (JWT/Refresh Token/OAuth), Angular Reactive Forms + Zod/class-validator, HTTP-only cookie, NestJS Throttler. Có silent refresh qua Angular Interceptor.
- Workflow chi tiết có sẵn trong docs gốc: Đăng ký, Đăng nhập, Quên mật khẩu, 2FA — tham khảo mục "1. Authentication Workflow" của `plan_357` nếu cần bám sát từng bước.

**dashboard**
- Feature: nhắn tin cá nhân (gửi/sửa/xoá, sticker, file attachment, xem lại file), tạo Server (cá nhân/nhóm/livestream), tạo Channel, Cộng đồng (Community), tìm kiếm, thêm bạn (friend request/accept/block), trạng thái hoạt động, thông báo.
- Core stack: Socket.IO, WebRTC (PeerJS/LiveKit/Mediasoup), Supabase PostgreSQL + Redis, Supabase Storage/S3, NgRx/Signals.
- Có sẵn workflow chi tiết: Friend/Social Workflow, Server & Channel Creation Workflow, Real-time Chat Workflow (gửi/sửa/xoá tin nhắn), Roles & Permissions Workflow, Notification Workflow — trong `plan_357` gốc.

**profile**
- Feature: xem profile bản thân/bạn bè, chỉnh sửa profile (avatar, banner, status message).
- Core stack: Supabase Storage, NestJS REST API + DTO validation.

**setting**
- Feature: setting account (thông tin, ngôn ngữ, đăng xuất, thông báo, đổi mật khẩu, 2FA), setting server, setting channel (phân quyền, invite link).
- Core stack: `@ngx-translate/core`, NestJS Guards + CASL/RBAC, Nanoid/Short UUID invite link TTL. Chi tiết ở "Roles & Permissions Workflow" trong docs gốc.

**livestream (optional/riêng của Fizzle, không có ở Nexus)**
- Feature: thiết lập stream (tiêu đề, category, thumbnail), tạo/quản lý stream key (OBS), Go Live/Stop Live qua webhook, viewer real-time + badge LIVE + số người xem, chat trực tiếp trong stream, kiểm duyệt chat (Mod), follow streamer + thông báo khi live.
- Core stack: RTMP ingest → HLS (Cloudflare Stream/Mux cho MVP), hls.js cho playback, Socket.IO hoặc Supabase Realtime cho chat, bảng `streams`/`follows`/`stream_messages`, NestJS webhook endpoint nhận `stream.started`/`stream.ended`.
- Workflow chi tiết đầy đủ có ở mục "8. Livestream Workflow" trong `plan_357` gốc — nên đọc kỹ trước khi lập plan vì đây là phần phức tạp nhất.

## Timeline tham khảo (không phải quy trình bắt buộc của skill — chỉ để hiểu bối cảnh)
4 tuần (20/07–16/08), theo bảng Phase trong docs gốc: Phase 1 Foundation & Auth, Phase 2 Server/Channel/Chat/Friend, Phase 3 Voice/Roles/Settings/Notification, Phase 4 Livestream + Testing + Deployment.
