# Nexus (lớp 246) — Frontend tree (`src/app/`)

Cây thư mục này **dựng riêng cho Nexus từ `plan_246`** (không phải bản suy ra từ project khác).
Angular 21, standalone components + Signals, feature routes lazy-loaded. Component UI dựng trên
**Angular Material**, `shared/ui/` là lớp wrap Material theo design system của repo; icon dùng
`mat-icon` (Material Symbols qua Google Fonts). Nếu mentor gửi bản cập nhật, thả vào
`docs/folder-structure-nexus-client.md` ở root workspace — skill sẽ ưu tiên bản đó.

## Phạm vi Nexus (chốt từ plan_246 — đọc kỹ vì khác các clone Discord khác)
- Server chỉ có **2 loại: cá nhân (personal) và nhóm (group)** — KHÔNG có community, KHÔNG có
  livestream.
- Có **voice/video call** (WebRTC) cho voice channel.
- **AI agent là optional**, không nằm trong phân công cố định của 4 member.

## Bảng ownership — ai được đụng vào đâu (tra trước khi scaffold/code)

| Member | Sở hữu chính (tạo/sửa tự do) | Có thể cần đụng (hạ tầng dùng chung — sửa xong phải khai PLAN.md + báo nhóm) |
| --- | --- | --- |
| Mon (Auth) | `features/auth/**` | `core/auth/**` (auth store/service/guard — mọi trang khác phụ thuộc route guard) |
| Minh Tài (Dashboard) | `features/dashboard/**`, `features/servers/**`, `features/voice/**` | `core/realtime/**`, `core/notifications/**` |
| Triều Dược (Profile) | `features/profile/**` | — |
| Trường Giang (Setting) | `features/settings/**` | — |
| (optional, chưa ai nhận) | `features/ai-agent/**` | `core/realtime/**` (nếu assistant stream trả lời qua socket) |
| (dùng chung, không của riêng ai) | — | `shared/**`, `layouts/**`, `core/http/**`, `core/services/**`, `core/models/**` |

## Cây thư mục

```
app/
├── app.ts / app.html / app.css / app.config.ts / app.routes.ts   # providers + root router-outlet
│
├── core/                          # singleton toàn app (providedIn: 'root'), load 1 lần
│   ├── auth/
│   │   ├── auth.store.ts          # signal store: session, currentUser, status
│   │   ├── auth.service.ts        # POST /auth/login|register|refresh|logout|forgot|reset|2fa
│   │   ├── auth-guard.ts          # chặn route cần đăng nhập
│   │   ├── guest-guard.ts         # đẩy user đã đăng nhập ra khỏi /auth
│   │   └── token.model.ts
│   ├── http/
│   │   ├── api.config.ts          # base URL, withCredentials
│   │   ├── auth-interceptor.ts    # gắn access token; silent refresh khi 401
│   │   └── error-interceptor.ts   # chuẩn hoá lỗi -> toast
│   ├── realtime/
│   │   ├── socket.service.ts      # vòng đời socket.io-client (connect/reconnect/auth)
│   │   ├── realtime-events.ts     # hằng số tên event (khớp với BE)
│   │   └── presence.store.ts      # signal store: map online/idle/offline, trạng thái mic/tai nghe
│   ├── notifications/
│   │   ├── notification.store.ts  # signal store: badge chưa đọc, hàng đợi toast
│   │   └── notification.service.ts# REST lấy lịch sử + mark-read; subscribe socket
│   ├── services/
│   │   ├── supabase.service.ts    # client supabase-js (Storage upload, Realtime fallback)
│   │   ├── theme.service.ts       # toggle dark/light
│   │   ├── upload.service.ts      # upload + resize avatar/banner/attachment lên Supabase Storage
│   │   └── i18n.service.ts        # wiring @ngx-translate (đổi ngôn ngữ)
│   └── models/
│       ├── user.model.ts  server.model.ts  channel.model.ts  message.model.ts
│       ├── friend.model.ts  role.model.ts  permission.model.ts
│       └── notification.model.ts  voice.model.ts
│
├── shared/                        # UI tái sử dụng (dumb, không biết feature); WRAP Angular Material
│   ├── ui/
│   │   ├── button/                # wrap mat-button: primary / accent / ghost / danger / icon
│   │   ├── input/  textarea/  form-field/   # wrap mat-form-field + lỗi/label; đi với Reactive Forms + Zod
│   │   ├── modal/  dialog/  drawer/         # wrap mat-dialog / overlay
│   │   ├── avatar/                # avatar + chấm presence
│   │   ├── badge/                 # count / status
│   │   ├── dropdown/  context-menu/  tooltip/  popover/   # wrap mat-menu / mat-tooltip
│   │   ├── tabs/  segmented-tabs/  toggle/  switch/       # wrap mat-tabs / mat-slide-toggle
│   │   ├── card/  spinner/  skeleton/  empty-state/       # wrap mat-card / mat-progress-spinner
│   │   ├── toast/  toast-container/         # wrap mat-snack-bar
│   │   └── icon/                  # bọc mat-icon (Material Symbols qua Google Fonts)
│   ├── directives/
│   │   ├── click-outside.ts  autofocus.ts  infinite-scroll.ts
│   ├── pipes/
│   │   ├── time-ago.ts  file-size.ts  initials.ts  safe-url.ts
│   └── validators/
│       ├── auth.schema.ts         # Zod schema (login/register/reset)
│       └── profile.schema.ts
│
├── layouts/
│   ├── auth-layout/               # card căn giữa trên nền gradient (Login/Register/Forgot)
│   └── app-layout/                # khung Discord-clone chính:
│       ├── app-layout.ts/html/css
│       └── components/
│           ├── server-rail/       # cột icon server bên trái + nút thêm server
│           ├── channel-sidebar/   # danh sách channel + panel user (mic/tai nghe/setting) dưới cùng
│           ├── top-bar/           # search, tên channel, toggle call/pin/members
│           └── members-panel/     # cột phải: "Đang hoạt động" - member online
│
└── features/                      # feature routes lazy-loaded
    │
    ├── auth/                      # → auth-layout — sở hữu: Mon
    │   ├── login/                 # đăng nhập bằng email HOẶC số điện thoại
    │   │   ├── login.ts/html/css/spec.ts
    │   │   └── components/  login-form/            # form email/phone + mật khẩu
    │   ├── register/              # đăng ký
    │   │   ├── register.ts…
    │   │   └── components/  register-form/
    │   └── forgot-password/       # quên tài khoản/mật khẩu
    │       ├── forgot-password.ts…
    │       └── components/  request-reset-form/  reset-password-form/
    │
    ├── dashboard/                 # → app-layout — sở hữu: Minh Tài
    │   ├── dashboard.ts…          # shell/redirect vào channel hoặc friends-home
    │   ├── friends-home/          # landing DM: tab bạn bè (online/all/pending/add)
    │   │   └── components/  friends-tabs/  friend-list-item/  add-friend-form/  friend-request-item/
    │   ├── chat/                  # nhắn tin cá nhân (DM) + channel
    │   │   ├── chat.ts…
    │   │   ├── chat.store.ts       # signal store: message theo room, trạng thái pending/sent
    │   │   └── components/
    │   │       ├── message-list/           # scroll ảo
    │   │       ├── message-item/           # avatar, nội dung, tag đã sửa, actions
    │   │       ├── message-composer/       # ô nhập + nút sticker/file
    │   │       ├── message-actions/        # sửa / xoá / context menu
    │   │       ├── attachment-preview/     # bong bóng ảnh/file
    │   │       ├── sticker-picker/
    │   │       └── attachments-gallery/    # "Xem lại các file đã gửi"
    │   ├── search/                # tìm kiếm (user, server, message)
    │   │   └── components/  search-input/  search-results/
    │   └── notifications/         # dropdown trung tâm thông báo
    │       └── components/  notification-list/  notification-item/
    │
    ├── servers/                   # tạo/tham gia server + channel — sở hữu: Minh Tài
    │   ├── servers.store.ts        # signal store: danh sách server đã tham gia, server/channel active
    │   ├── create-server/          # modal: chọn loại (CHỈ cá nhân / nhóm), nhập tên, avatar
    │   │   └── components/  server-type-picker/ (chỉ personal | group)  server-details-form/
    │   ├── create-channel/         # modal: text / voice + quyền truy cập theo role
    │   └── join-server/            # landing link mời + accept
    │
    ├── profile/                   # sở hữu: Triều Dược
    │   ├── profile.ts…             # xem profile bản thân / bạn bè (modal hoặc page)
    │   ├── profile.store.ts
    │   └── components/
    │       ├── profile-card/  profile-banner/  profile-avatar/
    │       ├── profile-about/  mutual-friends/  mutual-servers/
    │       └── edit-profile/       # sửa thông tin, avatar, banner, status message
    │
    ├── settings/                  # route lồng + sidebar setting — sở hữu: Trường Giang
    │   ├── settings.ts…            # shell setting + nav trái
    │   ├── account/               # thông tin cá nhân, đổi mật khẩu, đăng xuất
    │   │   └── components/  account-info/  change-password/  danger-zone/
    │   ├── security/two-factor/    # bật 2FA (QR TOTP) + verify
    │   ├── notifications/          # tuỳ chỉnh thông báo
    │   ├── language/               # đổi ngôn ngữ (ngx-translate)
    │   ├── server-settings/        # sửa profile server, quyền truy cập, phân quyền, mời
    │   │   └── components/  server-overview/  roles-editor/  member-manager/  invite-manager/
    │   └── channel-settings/       # sửa profile channel, quyền, phân quyền, mời
    │       └── components/  channel-overview/  permissions-editor/
    │
    ├── voice/                     # voice/video channel (WebRTC) — sở hữu: Minh Tài
    │   ├── voice.store.ts          # signal store: participants, trạng thái mic/cam
    │   ├── voice-channel/
    │   │   └── components/  participant-tile/  voice-controls/  screen-share/
    │   └── services/  peer.service.ts       # signaling PeerJS/WebRTC qua socket
    │
    └── ai-agent/                  # OPTIONAL — không có member cố định
        ├── ai-agent.store.ts       # signal store: state chat assistant, trạng thái summarize theo channel
        ├── assistant-panel/        # "Nexus AI Assistant" — chat trực tiếp với AI
        │   └── components/  chat-window/  message-bubble/  prompt-input/
        ├── channel-summary/        # nút + panel "Tóm tắt kênh" (tin nhắn chưa đọc)
        └── services/  ai-agent.service.ts   # gọi BE modules/ai-agent
```

### Routing (`app.routes.ts`, tất cả lazy)
```
''            → redirect /app (nếu đã auth) hoặc /auth/login
/auth         → auth-layout    → login | register | forgot-password
/app          → app-layout (auth-guard)
   /app/friends
   /app/channels/:serverId/:channelId     → chat (channel)
   /app/dm/:userId                         → chat (DM)
   /app/voice/:channelId                   → voice-channel
   /app/@me/settings/**                    → settings (account/security/...)
   /app/servers/:serverId/settings/**      → settings (server/channel)
   /app/assistant                          → ai-agent (optional; có thể làm slide-over panel trong app-layout thay vì route riêng)
/invite/:code → join-server
```
