# Fizzle (lớp 357) — Frontend tree thật (`fizzle-fe/src/app/`)

Đây là cây thư mục CHÍNH THỨC do mentor Luke gửi (không còn là bản mặc định tạm thời). Angular
21, standalone components + Signals, lazy-loaded feature routes.

## Ai đụng vào đâu — bảng ownership (đọc trước khi scaffold hoặc code)

| Member | Sở hữu chính (tạo/sửa tự do) | Có thể cần đụng tới (hạ tầng dùng chung — sửa xong phải báo cho member khác biết) |
| --- | --- | --- |
| Thiện Phúc (Dashboard) | `features/dashboard/**`, `features/servers/**` (gồm `community/`), `features/voice/**` | `core/realtime/**`, `core/notifications/**` (socket, presence, notification store — dashboard là nơi dùng nhiều nhất nhưng auth/livestream cũng phụ thuộc) |
| Hoàng Khang (Profile, Setting) | `features/profile/**`, `features/settings/**` | — |
| Khánh Hưng (Login, Livestream) | `features/auth/**`, `features/livestream/**` | `core/auth/**` (auth store/service/guard — dashboard và mọi trang khác đều phụ thuộc route guard này) |
| (dùng chung, không thuộc 1 member) | — | `shared/**`, `layouts/**`, `core/http/**`, `core/services/**`, `core/models/**` |

Nguyên tắc: mỗi member code trong đúng phạm vi "sở hữu chính" của mình. Nếu phase yêu cầu sửa
phần "dùng chung", nói rõ với member đang code rằng thay đổi này ảnh hưởng người khác, và nhắc
họ báo lại cho mentor / các bạn liên quan trước khi commit — đây chính là lý do PLAN.md ở Bước 2
của SKILL.md phải liệt kê rõ file/folder dự kiến, kể cả phần dùng chung.

## Cây thư mục

```
app/
├── app.ts / app.html / app.css / app.config.ts / app.routes.ts   # (exists) — wire providers + root router-outlet
│
├── core/                          # app-wide singletons (providedIn: 'root'), loaded once
│   ├── auth/
│   │   ├── auth.store.ts          # signal store: session, currentUser, status
│   │   ├── auth.service.ts        # POST /auth/login|register|refresh|logout|forgot|reset|2fa
│   │   ├── auth-guard.ts          # protect app routes
│   │   ├── guest-guard.ts         # redirect logged-in users away from /auth
│   │   └── token.model.ts
│   ├── http/
│   │   ├── api.config.ts          # base URL, withCredentials
│   │   ├── auth-interceptor.ts    # attach access token; silent refresh on 401
│   │   └── error-interceptor.ts   # normalize errors -> toast
│   ├── realtime/
│   │   ├── socket.service.ts      # socket.io-client lifecycle (connect/reconnect/auth)
│   │   ├── realtime-events.ts     # event-name constants (mirror of BE)
│   │   └── presence.store.ts      # signal store: online/idle/dnd map, mic/headset state
│   ├── notifications/
│   │   ├── notification.store.ts  # signal store: unread badge, toast queue
│   │   └── notification.service.ts# REST fetch history + mark-read; subscribes to socket
│   ├── services/
│   │   ├── supabase.service.ts    # supabase-js client (Storage uploads, Realtime fallback)
│   │   ├── theme.service.ts       # dark/light toggle
│   │   ├── upload.service.ts      # avatar/banner/attachment upload + resize to Supabase Storage
│   │   └── i18n.service.ts        # @ngx-translate wiring (language switch)
│   └── models/
│       ├── user.model.ts  server.model.ts  channel.model.ts  message.model.ts
│       ├── friend.model.ts  role.model.ts  permission.model.ts
│       ├── notification.model.ts  stream.model.ts  voice.model.ts
│
├── shared/                        # reusable design-system UI (dumb, no feature knowledge)
│   ├── ui/
│   │   ├── button/                # variants: primary / accent / ghost / danger / icon (pill radius)
│   │   ├── input/  textarea/  form-field/   # + error/label; pairs with Reactive Forms + Zod
│   │   ├── modal/  dialog/  drawer/
│   │   ├── avatar/                # avatar + presence-dot overlay
│   │   ├── badge/                 # count / status / LIVE badge
│   │   ├── dropdown/  context-menu/  tooltip/  popover/
│   │   ├── tabs/  segmented-tabs/  toggle/  switch/
│   │   ├── card/  spinner/  skeleton/  empty-state/
│   │   ├── toast/  toast-container/
│   │   └── icon/                  # sprite / inline SVG registry
│   ├── directives/
│   │   ├── click-outside.ts  autofocus.ts  infinite-scroll.ts  tooltip.ts
│   ├── pipes/
│   │   ├── time-ago.ts  file-size.ts  initials.ts  safe-url.ts
│   └── validators/
│       ├── auth.schema.ts         # Zod schemas (login/register/reset)
│       └── profile.schema.ts
│
├── layouts/
│   ├── auth-layout/               # centered card over animated gradient (Login/Register/Forgot)
│   └── app-layout/                # the Discord shell:
│       ├── app-layout.ts/html/css
│       └── components/
│           ├── server-rail/       # far-left vertical server icons + add-server button
│           ├── channel-sidebar/   # channels list + user panel (mic/headset/settings) at bottom
│           ├── top-bar/           # search, channel title, call/pin/members toggles
│           └── members-panel/     # right rail: "Đang hoạt động" online members
│
└── features/                      # routed, lazy-loaded feature areas
    │
    ├── auth/                      # → uses auth-layout — sở hữu: Khánh Hưng
    │   ├── login/
    │   │   ├── login.ts/html/css/spec.ts
    │   │   └── components/  login-form/  qr-login-panel/   # email/phone form + "Đăng nhập bằng QR"
    │   ├── register/
    │   │   ├── register.ts…
    │   │   └── components/  register-form/  otp-verify/    # OTP / email verification step
    │   └── forgot-password/
    │       ├── forgot-password.ts…
    │       └── components/  request-reset-form/  reset-password-form/
    │
    ├── dashboard/                 # → uses app-layout (the main authenticated area) — sở hữu: Thiện Phúc
    │   ├── dashboard.ts…          # shell/redirect to a channel or friends home
    │   ├── friends-home/          # DM landing: "Bạn bè" tabs (online/all/pending/blocked/add)
    │   │   └── components/  friends-tabs/  friend-list-item/  add-friend-form/  friend-request-item/
    │   ├── chat/                  # DM + channel messaging (shared component set)
    │   │   ├── chat.ts…
    │   │   ├── chat.store.ts       # signal store: messages per room, pending/sent state
    │   │   └── components/
    │   │       ├── message-list/           # virtualized scroll
    │   │       ├── message-item/           # avatar, content, edited tag, actions
    │   │       ├── message-composer/       # input + emoji/sticker/file buttons
    │   │       ├── message-actions/        # edit / delete / react context menu
    │   │       ├── attachment-preview/     # image/file bubble
    │   │       ├── sticker-picker/  emoji-picker/
    │   │       └── attachments-gallery/    # "Xem lại các file đã gửi"
    │   ├── search/                # global search (users, servers, messages) overlay
    │   │   └── components/  search-input/  search-results/
    │   └── notifications/         # notification center dropdown
    │       └── components/  notification-list/  notification-item/
    │
    ├── servers/                   # server + channel creation/joining — sở hữu: Thiện Phúc
    │   ├── servers.store.ts        # signal store: joined servers, active server/channel
    │   ├── create-server/          # modal flow: choose type (personal/group/community/livestream)
    │   │   └── components/  server-type-picker/  server-details-form/
    │   ├── create-channel/         # modal: text / voice / livestream + access by role
    │   ├── join-server/            # invite-link landing + accept
    │   └── community/              # community discovery/home surface
    │       └── components/  community-header/  community-channel-list/
    │
    ├── profile/                   # sở hữu: Hoàng Khang
    │   ├── profile.ts…             # view self / friend profile (modal or page)
    │   ├── profile.store.ts
    │   └── components/
    │       ├── profile-card/  profile-banner/  profile-avatar/
    │       ├── profile-about/  mutual-friends/  mutual-servers/
    │       └── edit-profile/       # edit info, avatar, banner, status message
    │
    ├── settings/                  # nested route with a settings sidebar — sở hữu: Hoàng Khang
    │   ├── settings.ts…            # settings shell + left nav
    │   ├── account/               # info, change password, logout
    │   │   └── components/  account-info/  change-password/  danger-zone/
    │   ├── security/  ├─ two-factor/   # 2FA enable (QR TOTP) + verify
    │   ├── notifications/          # notification preferences (web push / email toggles)
    │   ├── language/               # ngx-translate language switch
    │   ├── server-settings/        # edit server profile, roles, members, invites
    │   │   └── components/  server-overview/  roles-editor/  member-manager/  invite-manager/
    │   └── channel-settings/       # edit channel profile, permissions, invite
    │       └── components/  channel-overview/  permissions-editor/
    │
    ├── voice/                     # WebRTC voice/video channel — sở hữu: Thiện Phúc
    │   ├── voice.store.ts          # signal store: participants, mic/cam state
    │   ├── voice-channel/
    │   │   └── components/  participant-tile/  voice-controls/  screen-share/
    │   └── services/  peer.service.ts       # PeerJS/WebRTC signaling over socket
    │
    └── livestream/                # sở hữu: Khánh Hưng (optional / Phase 4)
        ├── stream-view/           # viewer page: player + chat + info
        │   └── components/  hls-player/  stream-info/  live-badge/  viewer-count/  stream-chat/  chat-moderation/
        ├── stream-setup/          # streamer: title, category/tag, thumbnail, description
        ├── streamer-dashboard/    # stream key, connection status, chat mod panel, Go Live / Stop Live
        │   └── components/  stream-key-panel/  connection-status/  go-live-controls/
        └── follow/                # follow button + "X đang live" surface
```

### Routing (`app.routes.ts`, all lazy)
```
''            → redirect /app (if auth) or /auth/login
/auth         → auth-layout    → login | register | forgot-password
/app          → app-layout (auth-guard)
   /app/friends
   /app/channels/:serverId/:channelId     → chat (channel)
   /app/dm/:userId                         → chat (DM)
   /app/voice/:channelId                   → voice-channel
   /app/@me/settings/**                    → settings (account/security/...)
   /app/servers/:serverId/settings/**      → settings (server/channel)
   /app/live/:streamId                     → stream-view
   /app/studio                             → streamer-dashboard
/invite/:code → join-server
```
