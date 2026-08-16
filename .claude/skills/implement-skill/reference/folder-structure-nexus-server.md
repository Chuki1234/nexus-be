# Nexus (lớp 246) — Backend tree (`src/`)

Cây thư mục này **dựng riêng cho Nexus từ `plan_246`** (không phải bản suy ra từ project khác).
NestJS 11, modular. Supabase = Postgres + Auth + Storage; Redis = socket session + presence
cache + queue cho BullMQ (nếu làm ai-agent); Socket.IO gateway cho realtime. Nếu mentor gửi bản
cập nhật, thả vào `docs/folder-structure-nexus-server.md` ở root workspace — skill ưu tiên bản đó.

## Phạm vi Nexus (chốt từ plan_246)
- Server chỉ **cá nhân (personal) / nhóm (group)** — enum `type` không có community/livestream.
- Có **voice/video** (WebRTC signaling qua gateway).
- **AI agent optional** (Summarize Channel, Nexus AI Assistant, Smart Security & Moderation).

## ⚠️ Nhắc lại quy tắc Database (chi tiết ở SKILL.md)
Member KHÔNG tự đổi schema Supabase. Cần bảng/cột mới → viết file
`backend/migrations/<timestamp>_<mo-ta>.sql`, gửi mentor, chờ mentor tạo bảng rồi mới nối code.
Các `*.entity.ts`/mapping dưới đây chỉ **ánh xạ tới bảng đã tồn tại**, không dùng để tự sinh schema.

## Bảng ownership — ai được đụng vào đâu

| Member | Sở hữu chính (tạo/sửa tự do) | Có thể cần đụng (hạ tầng dùng chung — khai PLAN.md + báo nhóm) |
| --- | --- | --- |
| Mon (Auth) | `modules/auth/**` | — |
| Minh Tài (Dashboard) | `modules/friends/**`, `modules/servers/**`, `modules/channels/**`, `modules/messages/**`, `modules/voice/**`, `modules/notifications/**` | — |
| Triều Dược (Profile) | `modules/users/**` | — |
| Trường Giang (Setting) | `modules/roles/**`, `modules/invites/**` | — |
| (optional, chưa ai nhận) | `modules/ai-agent/**` | `modules/messages/**` (chỉ ĐỌC tin nhắn để tóm tắt/kiểm duyệt, không sửa code module này) |
| (dùng chung, không của riêng ai) | — | `common/**`, `infra/**`, `config/**` |

## Cây thư mục

```
src/
├── main.ts                        # bootstrap: CORS, cookie-parser, global pipes/filters, WS adapter
├── app.module.ts                  # import config + infra + tất cả feature module
│
├── config/
│   ├── config.module.ts
│   └── env.validation.ts          # validate env (Supabase keys, JWT secrets, Redis; + OpenAI/Gemini key nếu làm ai-agent)
│
├── common/
│   ├── guards/
│   │   ├── jwt-auth.guard.ts       # guard access-token cho REST
│   │   ├── ws-jwt.guard.ts         # auth handshake socket
│   │   ├── refresh-token.guard.ts
│   │   └── permissions.guard.ts    # RBAC (CASL / custom) cho hành động server/channel
│   ├── decorators/
│   │   ├── current-user.decorator.ts  @Roles()  @Permissions()  @Public()
│   ├── interceptors/  logging.interceptor.ts  transform.interceptor.ts
│   ├── filters/       all-exceptions.filter.ts  ws-exception.filter.ts
│   ├── pipes/         zod-validation.pipe.ts       # (hoặc DTO class-validator)
│   └── realtime/
│       └── events.ts               # hằng số tên event socket (khớp với FE)
│
├── infra/
│   ├── supabase/
│   │   ├── supabase.module.ts
│   │   └── supabase.service.ts     # admin client (auth admin, DB, storage)
│   ├── redis/
│   │   ├── redis.module.ts  redis.service.ts       # presence, socket session, cache (+ BullMQ connection)
│   └── storage/
│       └── storage.service.ts      # upload avatar/banner/attachment + signed URL
│
└── modules/
    ├── auth/                       # sở hữu: Mon
    │   ├── auth.module.ts  auth.controller.ts  auth.service.ts
    │   ├── two-factor.service.ts   # tạo QR TOTP + verify (dùng ở Setting account)
    │   ├── strategies/  jwt.strategy.ts  refresh.strategy.ts
    │   └── dto/  login.dto.ts  register.dto.ts  reset-password.dto.ts
    │
    ├── users/                      # xem/sửa profile — sở hữu: Triều Dược
    │   ├── users.module.ts  users.controller.ts  users.service.ts
    │   └── dto/  update-profile.dto.ts  update-status.dto.ts
    │
    ├── friends/                    # thêm bạn, kết bạn, chặn — sở hữu: Minh Tài
    │   ├── friends.module.ts  friends.controller.ts  friends.service.ts
    │   ├── friends.gateway.ts      # realtime friend-request/accept/remove
    │   └── dto/  send-request.dto.ts
    │
    ├── servers/                    # sở hữu: Minh Tài
    │   ├── servers.module.ts  servers.controller.ts  servers.service.ts
    │   └── dto/  create-server.dto.ts  update-server.dto.ts   # type enum: personal | group (CHỈ 2 loại)
    │
    ├── channels/                   # sở hữu: Minh Tài
    │   ├── channels.module.ts  channels.controller.ts  channels.service.ts
    │   └── dto/  create-channel.dto.ts  update-channel.dto.ts # kind: text | voice
    │
    ├── invites/                    # link mời (Nanoid + TTL/max-uses) — sở hữu: Trường Giang (Setting)
    │   ├── invites.module.ts  invites.controller.ts  invites.service.ts
    │   └── dto/  create-invite.dto.ts
    │
    ├── messages/                   # nhắn tin DM + channel — sở hữu: Minh Tài
    │   ├── messages.module.ts  messages.controller.ts  messages.service.ts
    │   ├── chat.gateway.ts         # message:send|new|edit|delete, typing, sticker/attachment
    │   └── dto/  send-message.dto.ts  edit-message.dto.ts
    │
    ├── roles/                      # RBAC (phân quyền server/channel) — sở hữu: Trường Giang (Setting)
    │   ├── roles.module.ts  roles.controller.ts  roles.service.ts
    │   ├── casl/  casl-ability.factory.ts
    │   └── dto/  create-role.dto.ts  assign-role.dto.ts
    │
    ├── voice/                      # WebRTC signaling — sở hữu: Minh Tài
    │   └── voice.gateway.ts        # voice:join|leave|user-joined|left, relay SDP/ICE, toggle mic/cam
    │
    ├── notifications/              # sở hữu: Minh Tài
    │   ├── notifications.module.ts  notifications.controller.ts  notifications.service.ts
    │   └── notifications.gateway.ts # push badge/toast realtime
    │
    └── ai-agent/                   # OPTIONAL — không có member cố định
        ├── ai-agent.module.ts  ai-agent.controller.ts  ai-agent.service.ts  # gọi OpenAI/Gemini qua LangChainJS
        ├── summarize.processor.ts  # BullMQ job: tóm tắt channel (task tốn thời gian, chạy nền)
        ├── moderation.service.ts   # phát hiện spam/link lừa đảo; chỉ ĐỌC modules/messages
        └── dto/  summarize-channel.dto.ts  ask-assistant.dto.ts
```

## Bắt buộc dùng Nest CLI — mọi loại file có schematic
Đứng trong repo backend, scaffold bằng CLI (không viết tay boilerplate):

```bash
nest g module modules/<ten-module>
nest g controller modules/<ten-module> --no-spec
nest g service modules/<ten-module> --no-spec
nest g gateway modules/<ten-module> --no-spec   # nếu module cần realtime (messages, voice, notifications, friends, ai-agent)
```

Chỉ `dto/`, `strategies/`, `casl/`, `*.processor.ts` (BullMQ) tạo tay — Nest CLI không có
schematic riêng cho các loại này. Không chắc cú pháp/flag → chạy `nest generate --help` trước.
