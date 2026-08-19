# Fizzle (lớp 357) — Backend tree thật (`fizzle-be/src/`)

Đây là cây thư mục CHÍNH THỨC do mentor Luke gửi (không còn là bản mặc định tạm thời). NestJS
11, modular. Supabase = Postgres + Auth + Storage provider; Redis = socket sessions + presence
cache; Socket.IO gateways cho realtime.

## Ai đụng vào đâu — bảng ownership (đọc trước khi scaffold hoặc code)

| Member | Sở hữu chính (tạo/sửa tự do) | Có thể cần đụng tới (hạ tầng dùng chung — sửa xong phải báo cho member khác biết) |
| --- | --- | --- |
| Thiện Phúc (Dashboard) | `modules/friends/**`, `modules/servers/**`, `modules/channels/**`, `modules/messages/**`, `modules/voice/**` (gateway), `modules/notifications/**` | — |
| Hoàng Khang (Profile, Setting) | `modules/users/**`, `modules/roles/**`, `modules/invites/**` | — |
| Khánh Hưng (Login, Livestream) | `modules/auth/**`, `modules/livestream/**` | — |
| (dùng chung, không thuộc 1 member) | — | `common/**` (guard, decorator, filter, pipe), `infra/**` (supabase, redis, storage), `config/**` |

Nguyên tắc giống bên client: mỗi member code trong đúng module của mình. Nếu phase cần sửa
`common/` hoặc `infra/` (vd thêm 1 guard mới, đổi cấu hình Redis), phải ghi rõ trong PLAN.md ở
Bước 2 của SKILL.md và báo các bạn khác biết vì ai cũng dùng chung phần này.

## Cây thư mục

```
src/
├── main.ts                        # bootstrap: CORS, cookie-parser, global pipes/filters, WS adapter
├── app.module.ts                  # imports config + infra + all feature modules
│
├── config/
│   ├── config.module.ts
│   └── env.validation.ts          # validate env (Supabase keys, JWT secrets, Redis, stream webhook)
│
├── common/
│   ├── guards/
│   │   ├── jwt-auth.guard.ts       # REST access-token guard
│   │   ├── ws-jwt.guard.ts         # socket handshake auth
│   │   ├── refresh-token.guard.ts
│   │   └── permissions.guard.ts    # RBAC (CASL / custom) for server/channel actions
│   ├── decorators/
│   │   ├── current-user.decorator.ts  @Roles()  @Permissions()  @Public()
│   ├── interceptors/  logging.interceptor.ts  transform.interceptor.ts
│   ├── filters/       all-exceptions.filter.ts  ws-exception.filter.ts
│   ├── pipes/         zod-validation.pipe.ts       # (or class-validator DTOs)
│   └── realtime/
│       └── events.ts               # socket event-name constants (mirror of FE)
│
├── infra/
│   ├── supabase/
│   │   ├── supabase.module.ts
│   │   └── supabase.service.ts     # admin client (auth admin, DB, storage)
│   ├── redis/
│   │   ├── redis.module.ts  redis.service.ts       # presence, socket session, cache
│   └── storage/
│       └── storage.service.ts      # avatar/banner/attachment upload + signed URLs
│
└── modules/
    ├── auth/                       # sở hữu: Khánh Hưng
    │   ├── auth.module.ts  auth.controller.ts  auth.service.ts
    │   ├── two-factor.service.ts   # TOTP QR generate + verify
    │   ├── strategies/  jwt.strategy.ts  refresh.strategy.ts
    │   └── dto/  login.dto.ts  register.dto.ts  verify-otp.dto.ts  reset-password.dto.ts
    │
    ├── users/                      # profile view/edit — sở hữu: Hoàng Khang
    │   ├── users.module.ts  users.controller.ts  users.service.ts
    │   └── dto/  update-profile.dto.ts  update-status.dto.ts
    │
    ├── friends/                    # friend requests, friendships, block — sở hữu: Thiện Phúc
    │   ├── friends.module.ts  friends.controller.ts  friends.service.ts
    │   ├── friends.gateway.ts      # realtime friend-request/accept/remove events
    │   └── dto/  send-request.dto.ts
    │
    ├── servers/                    # sở hữu: Thiện Phúc
    │   ├── servers.module.ts  servers.controller.ts  servers.service.ts
    │   └── dto/  create-server.dto.ts  update-server.dto.ts   # type enum: personal | group | community | livestream
    │
    ├── channels/                   # sở hữu: Thiện Phúc
    │   ├── channels.module.ts  channels.controller.ts  channels.service.ts
    │   └── dto/  create-channel.dto.ts  update-channel.dto.ts
    │
    ├── invites/                    # sở hữu: Hoàng Khang (Setting) — Nanoid + TTL/max-uses
    │   ├── invites.module.ts  invites.controller.ts  invites.service.ts
    │   └── dto/  create-invite.dto.ts
    │
    ├── messages/                   # DM + channel messaging — sở hữu: Thiện Phúc
    │   ├── messages.module.ts  messages.controller.ts  messages.service.ts
    │   ├── chat.gateway.ts         # message:send|new|edit|delete, typing
    │   └── dto/  send-message.dto.ts  edit-message.dto.ts
    │
    ├── roles/                      # RBAC — sở hữu: Hoàng Khang (Setting)
    │   ├── roles.module.ts  roles.controller.ts  roles.service.ts
    │   ├── casl/  casl-ability.factory.ts
    │   └── dto/  create-role.dto.ts  assign-role.dto.ts
    │
    ├── voice/                      # sở hữu: Thiện Phúc
    │   └── voice.gateway.ts        # WebRTC signaling (voice:join|leave|user-joined|left, SDP/ICE relay)
    │
    ├── notifications/              # sở hữu: Thiện Phúc
    │   ├── notifications.module.ts  notifications.controller.ts  notifications.service.ts
    │   ├── notifications.gateway.ts # realtime badge/toast push
    │   └── web-push.service.ts      # offline Web Push
    │
    └── livestream/                 # sở hữu: Khánh Hưng (optional / Phase 4)
        ├── streams.module.ts  streams.controller.ts  streams.service.ts
        ├── stream-webhook.controller.ts   # receives stream.started / stream.ended from Cloudflare/Mux
        ├── stream-chat.gateway.ts          # stream_messages room + viewer count + moderation
        ├── follows.service.ts
        └── dto/  create-stream.dto.ts
```
