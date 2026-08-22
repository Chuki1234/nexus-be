# Dashboard — Kế hoạch triển khai

> Bản kế hoạch cho trang Dashboard. Mọi quyết định ở đây phải khớp với
> [`NEXUS_CONTEXT.md`](NEXUS_CONTEXT.md) — nếu lệch thì `NEXUS_CONTEXT.md` thắng.
>
> Lập ngày: 31/07/2026 · Còn 16 ngày tới hạn 16/08 · Mốc kiểm tra 08/08 (còn 8 ngày)

---

### Phase UI-29 — Giao diện & Kết nối Voice Room WebRTC (LiveKit) chuẩn NexusCord

Status: APPROVED

> Thiết kế và triển khai Voice Room toàn diện thuộc Dashboard: giao diện phòng thoại/video chuẩn sản phẩm thật, có mic, camera, chia sẻ màn hình, danh sách người tham gia và trạng thái kết nối tương tự trải nghiệm Discord nhưng mang ngôn ngữ thiết kế NexusCord Hybrid (deep-teal, brand-green, typography Euclid Circular A/Manrope, WCAG AA, full responsiveness).
>
> 1. **Kiến trúc WebRTC & Backend Token:**
>    - Frontend Angular 21 kết nối media qua `livekit-client`.
>    - Backend NestJS cấp token bảo mật qua `livekit-server-sdk` tại `POST /api/voice/channels/:channelId/token` (hoặc `POST /api/voice/token`).
>    - Token xác thực người dùng qua JWT/Supabase, kiểm tra quyền `CONNECT_VOICE` và `SPEAK_VOICE` của channel, không hardcode API secret ở client.
>    - Tên phòng chuẩn: `nexus:{serverId}:voice:{channelId}`.
>    - Xử lý mượt mà khi thiếu biến môi trường LiveKit (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), hiển thị thông báo cấu hình rõ ràng mà không làm crash app.
> 2. **Trạng thái & Vòng đời Voice Room (State Machine):**
>    - Quản lý các trạng thái: `idle` | `requesting-permission` | `previewing` | `connecting` | `connected` | `reconnecting` | `disconnected` | `error`.
>    - Xử lý đầy đủ các ca: Permission denied, no device, device busy, network weak/reconnecting, room full, kick/server disconnect.
>    - Khi rời phòng (Leave/Disconnect), ngắt kết nối và tắt hoàn toàn local tracks (tắt đèn camera/mic phần cứng).
> 3. **Bố cục & Giao diện (Layout & UI/UX):**
>    - **Header:** Icon `volume_up`/`spatial_audio`, tên voice channel, subtitle/status, nút chat drawer, danh sách thành viên, grid/focus mode, fullscreen.
>    - **Trạng thái chưa tham gia (Unjoined / Voice Empty State):** Không để màn hình trống, hiển thị illustration, tên channel, số người đang trong phòng, mô tả ngắn, nút CTA “Tham gia thoại” và nút phụ “Xem thiết bị” (mở pre-join preview).
>    - **Pre-join preview:** Camera preview / avatar fallback, chọn microphone/camera/output speaker, audio level test meter trực quan, toggle mic/cam trước khi vào.
>    - **Connected Stage (Participant Grid):**
>      - 1 participant: focus tile lớn.
>      - 2 participants: 2 cột cân bằng.
>      - 3–4 participants: grid 2×2.
>      - 5–9 participants: grid 3×3.
>      - Nhiều hơn: grid responsive / pagination filmstrip.
>      - Screen share mode: luồng chia sẻ màn hình chiếm stage chính, participants chuyển thành filmstrip ngang/dọc.
>      - Mỗi Participant Tile: Video stream khi cam bật, Avatar fallback sắc nét khi cam tắt, Display name, Badge "Bạn", icon `mic_off`/`videocam_off`, connection quality indicator, viền speaking màu brand-green dịu khi đang nói, menu tùy chọn khi hover/focus, skeleton loading.
>    - **Control Bar:** Thanh điều khiển cố định đáy stage gồm: Mic toggle (`mic`/`mic_off`) kèm menu chọn input device/test mic, Camera toggle (`videocam`/`videocam_off`) kèm menu chọn camera, Screen share toggle (`screen_share`/`stop_screen_share`), Nút Mời (`person_add`), Activities placeholder disabled kèm tooltip, Participant list toggle (`group`), Fullscreen toggle (`fullscreen`), Ngắt kết nối (`call_end` màu danger riêng).
>    - **Channel Sidebar & User Panel Integration:**
>      - Khi kết nối thoại: Voice channel trên sidebar đổi sang trạng thái connected (icon/chữ brand-green, hiển thị thời lượng cuộc gọi).
>      - Danh sách thành viên đang ở trong phòng thoại xuất hiện thụt lề ngay dưới voice channel trên sidebar.
>      - User panel ở đáy sidebar hiển thị "Đã Kết Nối Giọng Nói", tên channel/server, sound wave/ping indicator, nút disconnect nhanh, và thanh quick action toolbar (screen share, video, activity).

#### Mục tiêu theo ba tiêu chí

- **UI/UX:**
  - Bám sát design system NexusCord Hybrid: Dark mode deep-teal `#001e2b`, `#002634`, `#003d4f`, brand-green `#00ed64` cho speaking/connected/CTA, text ink/slate/steel.
  - Sử dụng Angular Material wrapper, `mat-icon` (Material Symbols), pill buttons/badges, card bo tròn 12px.
  - Thiết kế responsive mượt mà trên desktop rộng, laptop nhỏ và mobile/tablet.
  - Đảm bảo chuẩn WCAG AA, focus-visible, keyboard navigation, tooltip, ARIA labels và tôn trọng `prefers-reduced-motion`.
- **Feature:**
  - Kết nối LiveKit WebRTC thật (publish/subscribe audio, video, screen share).
  - Tự động phát hiện active speaker và hiển thị viền xanh lá.
  - Chọn và chuyển đổi thiết bị microphone/camera/loa thời gian thực.
  - Trạng thái Sidebar Voice Channel và User Panel đồng bộ theo phiên gọi.
- **Data:**
  - API endpoint NestJS phát token có chữ ký ngắn hạn (TTL), kiểm tra quyền server/channel.
  - Clean state management với Angular Signals (OnPush).
  - Không truyền media qua Socket.IO, không ghi rác liên tục vào database.

#### File dự kiến thực hiện

- **Frontend (`nexus-fe`):**
  - `package.json` — bổ sung dependency `livekit-client`.
  - `src/app/core/api/voice-api.service.ts|spec.ts` — gọi API lấy LiveKit token.
  - `src/app/features/voice/services/voice-room.service.ts|spec.ts` — quản lý Room LiveKit, tracks, participants và signals.
  - `src/app/features/voice/services/media-device.service.ts|spec.ts` — quản lý media permissions, danh sách thiết bị và audio level meter.
  - `src/app/features/voice/voice-room/voice-room.ts|html|css|spec.ts` — Voice Room controller & layout.
  - `src/app/features/voice/voice-room/components/voice-prejoin/voice-prejoin.ts|html|css|spec.ts` — Pre-join modal/view.
  - `src/app/features/voice/voice-room/components/voice-stage/voice-stage.ts|html|css|spec.ts` — Grid layout & Screen share stage.
  - `src/app/features/voice/voice-room/components/participant-tile/participant-tile.ts|html|css|spec.ts` — Participant tile.
  - `src/app/features/voice/voice-room/components/voice-controls/voice-controls.ts|html|css|spec.ts` — Fixed bottom control bar.
  - `src/app/features/voice/voice-room/components/device-menu/device-menu.ts|html|css|spec.ts` — Menu chọn thiết bị mic/camera.
  - `src/app/features/dashboard/channel/channel.ts|html|css|spec.ts` — nhúng Voice Room vào kênh loại `voice`.
  - `src/app/layouts/app-layout/components/user-panel/user-panel.ts|html|css|spec.ts` — hiển thị trạng thái thoại đang kết nối.
  - `src/app/layouts/app-layout/components/channel-sidebar/components/channel-list.ts|html|css|spec.ts` — hiển thị danh sách người trong kênh thoại.
- **Backend (`nexus-be`):**
  - `package.json` — bổ sung dependency `livekit-server-sdk`.
  - `src/modules/voice/voice.module.ts`
  - `src/modules/voice/voice.controller.ts|spec.ts`
  - `src/modules/voice/voice.service.ts|spec.ts`
  - `src/modules/voice/dto/voice-token.dto.ts`
  - `src/app.module.ts` — import `VoiceModule`.

#### Kiểm chứng & Tiêu chí hoàn thành

- Khởi tạo kênh thoại hiển thị Unjoined Voice Empty State đầy đủ thông tin, không phải trang trống.
- Bấm "Xem thiết bị" mở Pre-join preview, hiển thị camera preview/avatar fallback và thanh đo âm lượng mic thật.
- Bấm "Tham gia thoại" xin token LiveKit, chuyển trạng thái `connecting` $\rightarrow$ `connected`.
- Lưới hiển thị thích ứng đúng số lượng participant (1, 2, 4, 9) và tự chuyển sang stage focus khi có screen share.
- Bật/tắt mic, camera, chia sẻ màn hình hoạt động chính xác với WebRTC tracks.
- Sidebar và User Panel hiển thị đúng trạng thái kết nối, thời lượng, và nút ngắt kết nối.
- Toàn bộ unit tests (`npm test`) và build (`npm run build`) trên cả FE và BE đều pass 100%.

---

### Phase UI-30 — Channel Actions Suite: Invite Dialog, Voice Chat Drawer & Channel Settings Modal

Status: APPROVED

> Thiết kế và triển khai trọn bộ giao diện cho 3 nút tùy chọn/tương tác kênh (Text & Voice Channel) trên Sidebar và trong Dashboard theo đúng ảnh thiết kế Discord mẫu nhưng mang ngôn ngữ NexusCord Hybrid (deep-teal, brand-green, typography Euclid/Manrope, WCAG AA):
>
> 1. **Nút 1 (`person_add` / Mời vào kênh) — Dialog Mời Bạn Bè (`InviteChannelDialog`):**
>    - Mở khi bấm nút `person_add` trên thanh kênh (hover), trong context menu hoặc trong Voice Room.
>    - Header: Tiêu đề `"Mời bạn bè vào [Tên máy chủ]"`, phụ đề `"Người nhận sẽ đến #[Tên kênh]"`, nút đóng 'X'.
>    - Ô tìm kiếm bạn bè nhanh với icon kính lúp.
>    - Danh sách bạn bè scrollable: Avatar, tên hiển thị, username, nút "Mời" (bấm đổi sang "Đã gửi").
>    - Khối liên kết mời ở đáy: Input readonly link `https://nexus.gg/c/[code]`, nút "Sao chép" (đổi sang "Đã sao chép" khi click), ghi chú thời hạn 30 ngày và nút "Chỉnh sửa link mời".
> 2. **Nút 2 (`chat_bubble_outline` / Mở Trò Chuyện) — Voice Chat Drawer (`VoiceChatDrawer`):**
>    - Mở khi bấm icon tin nhắn trên kênh thoại hoặc nút chat trong Header kênh thoại.
>    - Chia đôi màn hình Dashboard:
>      - Cột chính (trái): Voice Room Stage (phòng thoại, grid, controls).
>      - Drawer trượt vào (phải, 360px–420px): Khung chat văn bản riêng của kênh thoại.
>      - Header drawer: `# [Tên kênh thoại]` + nút đóng 'X'.
>      - Timeline: Tin nhắn mở đầu `"Chào mừng bạn đến với #[Tên kênh thoại]!"` + danh sách tin nhắn.
>      - Message Composer ở đáy: Input `+ Nhắn [Tên kênh thoại]`, nút emoji, nút gửi.
> 3. **Nút 3 (`settings` / Chỉnh sửa kênh) — Modal Cài Đặt Kênh (`ChannelSettingsModal`):**
>    - Mở khi bấm nút bánh răng ⚙️ trên kênh hoặc chọn "Chỉnh sửa kênh" từ Context Menu.
>    - Bố cục 2 cột toàn màn hình chuẩn NexusCord Settings:
>      - Sidebar trái (240px): Tiêu đề `# [TÊN_KÊNH] KÊNH CHAT / KÊNH THOẠI`, danh sách tab (Tổng quan, Quyền hạn, Lời mời, Tích hợp), mục Xóa kênh màu đỏ nguy hiểm (`delete`).
>      - Panel phải (Tab **Tổng quan**):
>        - 1. **Tên kênh**: Input chỉnh sửa tên kênh.
>        - 2. **Chủ đề kênh**: Textarea kèm thanh công cụ định dạng mini (B, I, U, S, Eye), bộ đếm ký tự 1024, placeholder: `Hãy hướng dẫn mọi người cách sử dụng kênh này!`.
>        - 3. **Chế độ chậm (Slowmode)**: Dropdown chọn thời gian (Tắt, 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h, 2h, 6h) kèm hướng dẫn chi tiết.
>        - 4. **Độ Hiển Thị Nội Dung**: Radio options (Mặc định / Kênh Nội Dung Ẩn / Kênh giới hạn độ tuổi) kèm mô tả chi tiết.
>        - 5. **Ẩn sau khi không hoạt động**: Dropdown chọn thời gian (3 Ngày, 1 Giờ, 24 Giờ, 1 Tuần).
>        - Nút đóng `ESC` ở góc trên bên phải (hỗ trợ phím tắt ESC).
>        - Thanh thông báo lưu thay đổi ở đáy khi form dirty: "Bạn có thay đổi chưa lưu" + "Đặt lại" + "Lưu thay đổi".

#### File dự kiến thực hiện

- `src/app/layouts/app-layout/components/channel-sidebar/components/invite-channel-dialog/invite-channel-dialog.ts|html|css|spec.ts`
- `src/app/features/voice/voice-room/components/voice-chat-drawer/voice-chat-drawer.ts|html|css|spec.ts`
- `src/app/features/settings/modals/channel-settings-modal/channel-settings-modal.ts|html|css|spec.ts`
- `src/app/layouts/app-layout/components/channel-sidebar/components/channel-list.ts|html|css|spec.ts`
- `src/app/features/voice/voice-room/voice-room.ts|html|css|spec.ts`
- `src/app/features/dashboard/channel/channel.ts|html|css|spec.ts`

#### Kiểm chứng & Tiêu chí hoàn thành

- Bấm nút `person_add` mở `InviteChannelDialog`, tìm kiếm bạn bè, bấm Mời, bấm Sao chép liên kết có phản hồi rõ ràng.
- Kênh thoại: Bấm icon tin nhắn mở `VoiceChatDrawer` chia đôi màn hình cạnh Voice Stage mượt mà, có thể soạn tin và đóng mở drawer.
- Bấm nút `settings` ⚙️ mở `ChannelSettingsModal` 2 cột, xem và chỉnh sửa Tổng quan (tên kênh, chủ đề kênh, slowmode, độ hiển thị, ẩn không hoạt động), nhấn ESC hoặc nút X để đóng.
- 100% unit tests frontend (`npm test`) và build (`npm run build`) pass.

---
### Phase UI-32 — Friends API & dữ liệu kết bạn thật trên Supabase

Status: APPROVED

> **Gate bắt buộc:** Tài đọc toàn bộ phase này trong `plans/dashboard.PLAN.md` rồi tự đổi đúng dòng trên thành `Status: APPROVED`. Chưa có chữ APPROVED thì không được scaffold hoặc sửa code.

#### Mục tiêu

Thay luồng “Thêm bạn” UI preview bằng dữ liệu thật qua Angular → NestJS → Supabase, dùng bảng `public.friendships` đã có trong migration `20260731090400_social_and_settings.sql`. Không tạo bảng `friends` hoặc `friend_requests` mới và không tự thay đổi schema dùng chung.

#### Phạm vi Backend — `src/modules/friends/**`

- Scaffold bằng Nest CLI: module, controller, service và test; gateway realtime để phase sau.
- Bảo vệ toàn bộ endpoint bằng `SupabaseAuthGuard`; user gửi request luôn lấy từ `@CurrentUser()`, không nhận requester ID từ body.
- API REST:
  - `POST /api/friends/requests` — gửi lời mời bằng username.
  - `GET /api/friends` — danh sách quan hệ `accepted`.
  - `GET /api/friends/requests` — tách `incoming` và `outgoing`.
  - `PATCH /api/friends/requests/:userId/accept` — người nhận chấp nhận.
  - `DELETE /api/friends/requests/:userId` — từ chối hoặc hủy lời mời.
  - `DELETE /api/friends/:userId` — xóa bạn.
- Chuẩn hóa cặp UUID thành `user_a_id < user_b_id`; chặn tự kết bạn, request trùng và race condition; map lỗi unique `23505` thành HTTP 409.
- Query profile theo lô, không N+1; response chỉ trả id, username, tên hiển thị, avatar, presence/status cần cho Dashboard, không trả email/phone/token.
- Phase này chưa làm block vì schema hiện thiếu `blocked_by`; nếu cần phải lập migration riêng và chờ mentor duyệt.

#### Phạm vi Frontend — `src/app/features/dashboard/friends/**`

- Generate `FriendsApiService`/store đúng cấu trúc Angular hiện có, tái sử dụng form và component Friends hiện tại.
- `AddFriendForm` emit username; page/store gọi API thật, có pending/success/error rõ ràng và không còn copy “Không có API nào được gọi”.
- Tab `Tất cả`/“Trực tuyến” đọc danh sách accepted thật; tab `Chờ duyệt` hiển thị incoming/outgoing thật với accept/reject/cancel.
- Khi demo bật, chỉ dùng ShellData để preview; khi demo tắt, tải API thật. Tuyệt đối không ghi dữ liệu demo xuống Supabase.
- Friendship và DM là hai dữ liệu khác nhau; không tự tạo conversation khi vừa accept. Chỉ tạo/mở DM khi user bấm “Nhắn tin” ở phase Messages.
- Không sửa Profile, Settings, Auth, Theme/Atmosphere hoặc feature của member khác.

#### Kiểm chứng và tiêu chí hoàn thành

- **Data:** xác nhận `public.friendships` tồn tại; không migration schema mới; mỗi cặp user chỉ có một dòng ordered; dữ liệu còn sau F5 và đăng nhập lại.
- **Feature:** dùng hai tài khoản thật A/B kiểm tra gửi → B thấy incoming → B accept → cả hai thấy nhau trong danh sách; kiểm tra từ chối, hủy, xóa bạn, tự kết bạn và request trùng.
- **UI/UX:** loading/empty/error/success đầy đủ, button pending không gửi hai lần, copy tiếng Việt rõ ràng, WCAG AA và Material icon theo NexusCord Hybrid.
- **Test BE:** service/controller cover 201/200/204 và 400/401/404/409, Supabase error mapping, không lộ dữ liệu nhạy cảm.
- **Test FE:** form submit, pending, error, incoming/outgoing, accept/reject/cancel, demo-off dùng API thật.
- Chạy `npm test` và `npm run build` ở cả nexus-fe và nexus-be; chạy `npm run check:shared` nếu sửa type dùng chung.
- Không commit/push; Tài tự kiểm tra và commit.

---

## Phạm vi

Dashboard chia làm hai mảng lớn:

| Mảng                                           | Số phase | Ước lượng    |
| ---------------------------------------------- | -------- | ------------ |
| **A. Nhắn tin** (chat message)                 | P0 – P11 | ~14.5 ngày   |
| **B. Gọi thoại** (live calling, LiveKit Cloud) | C1 – C5  | ~4.5 ngày    |
|                                                | **Tổng** | **~19 ngày** |

> 🔴 **Vượt ngân sách thời gian ngay từ đầu.** Còn 16 ngày (31/07 → 16/08), cần 19 ngày.
> Thiếu ~3 ngày, và con số này giả định không có ngày nào trượt. Ba lối thoát, theo thứ
> tự nên chọn: (1) cắt P10 sticker + C5 video/chia sẻ màn hình → tiết kiệm 1.5 ngày;
> (2) hoãn P9 DM và C4 gọi 1-1 sang sau hạn → tiết kiệm 3 ngày; (3) hạ gọi thoại xuống
> chỉ còn presence, bỏ LiveKit → tiết kiệm 3.5 ngày. Quyết sớm sẽ đỡ hơn nhiều so với
> cắt trong hoảng loạn ở tuần cuối.

---

## Ba thứ không bao giờ được cắt

Theo `NEXUS_CONTEXT.md` §4. Ghi lại đây vì cả ba đều rơi vào phần chat, và cả ba
đều dễ bị bỏ qua khi chạy nước rút:

| Yêu cầu                              | Nằm ở phase | Vì sao không cắt được                                                  |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------- |
| Cursor pagination (cấm `OFFSET`)     | P3          | `OFFSET` chậm dần theo độ sâu, và trả sai khi có tin mới chèn vào giữa |
| Read state đọc từ bảng `read_states` | P6          | Biến đếm trong memory sai ngay khi user F5 hoặc mở tab thứ hai         |
| Socket reconnect resync              | P5          | Mất mạng 3 giây là mất tin vĩnh viễn nếu không resync                  |

---

## A. Nhắn tin — 12 phase

Mỗi phase phải **chạy được và kiểm chứng được** trước khi sang phase sau.

### Bảng tổng quan

| Phase   | Nội dung                                     | Ước lượng  | Ghi chú                |
| ------- | -------------------------------------------- | ---------- | ---------------------- |
| **P0**  | Nền móng: schema, `shared/`, socket contract | 1.5 ngày   | Chặn tất cả            |
| **P1**  | Dashboard shell                              | 1 ngày     | Chặn Profile + Setting |
| **P2**  | Server & Channel (đọc)                       | 1 ngày     |                        |
| **P3**  | Đọc tin nhắn + cursor pagination             | 1.5 ngày   | ★ không cắt            |
| **P4**  | Gửi tin + optimistic UI                      | 1 ngày     |                        |
| **P5**  | Realtime socket + reconnect resync           | 2 ngày     | ★ không cắt            |
| **P6**  | Read state + badge unread                    | 1 ngày     | ★ không cắt            |
|         | — **Hết Messaging Core, mốc 08/08** —        | **9 ngày** | ⚠️ chỉ có 8 ngày       |
| **P7**  | Sửa / xoá / trả lời tin                      | 1 ngày     |                        |
| **P8**  | Đính kèm file & ảnh                          | 1.5 ngày   |                        |
| **P9**  | Tin nhắn riêng (DM 1-1)                      | 1.5 ngày   |                        |
| **P10** | Sticker                                      | 0.5 ngày   | Cắt được (§7 #4)       |
| **P11** | Thông báo in-app + mention                   | 1 ngày     |                        |

> ⚠️ **P0–P6 cần 9 ngày nhưng chỉ còn 8 ngày tới mốc 08/08.** Đã trượt trước khi
> bắt đầu. Hai cách xử lý: dời P8/P9/P10 xuống sau mốc (đã làm trong bảng trên),
> hoặc chấp nhận Messaging Core xong ngày 09–10/08. Không nên cắt bớt P5/P6 để
> kịp — đó là hai trong ba thứ cấm cắt.

---

### P0 — Nền móng

**Mục tiêu:** gỡ mọi thứ đang chặn. Không có UI nào ở phase này.

**Chức năng nhỏ**

1. **Đưa 15 bảng còn lại lên Supabase**
   - Chuyển `nexus_schema.sql` thành các file migration CLI (`supabase/migrations/`),
     vì repo đã đi theo đường CLI chứ không phải SQL Editor.
   - **Bảng `profiles` hoà giải bằng migration `ALTER`** (đã chốt 31/07 — giữ tài khoản
     test, giữ lịch sử migration sạch):

     | Việc        | Chi tiết                                                                                 |
     | ----------- | ---------------------------------------------------------------------------------------- |
     | Đổi tên cột | `birthdate` → `date_of_birth`                                                            |
     | Đổi kiểu    | `email`, `username`: `text` → `citext`                                                   |
     | Thêm cột    | `phone`, `avatar_url`, `banner_url`, `status_message`, `manual_presence`, `last_seen_at` |
     | Giữ nguyên  | Regex username **`{3,32}`** — sửa `nexus_schema.sql` từ `{2,32}` xuống cho khớp          |

   - **Sửa `nexus_schema.sql`** hai chỗ để nó không còn mâu thuẫn với các quyết định
     đã chốt: hạ regex username xuống `{3,32}`, và **xoá comment dòng 54–57** mô tả
     luồng login bằng phone (đã bỏ ở §3.6). Cột `phone` vẫn giữ, nhưng chỉ là thông
     tin hồ sơ, không phải định danh đăng nhập.
   - Cập nhật backend theo tên cột mới: `RegisterDto`, `AuthService.register`,
     `AuthService.completeProfile`, `AuthService.getProfile`, và form Angular.
   - ⚠️ Đổi `birthdate` → `date_of_birth` chạm vào code Auth **đang chạy được**. Chạy
     lại toàn bộ 36 test frontend sau khi sửa.

2. **Dựng `shared/` theo cách đã chốt** (copy có kiểm soát)
   - `nexus-fe/src/shared/` và `nexus-be/src/shared/` nội dung giống hệt.
   - Script `npm run check:shared` so sánh hai thư mục, thoát mã lỗi nếu lệch.
   - Nội dung: `permissions.ts` (hằng số bitfield), `dto/` (kiểu request/response),
     `socket-events.ts`.

3. **Viết socket event contract TRƯỚC khi implement**
   - `CLAUDE.md` gốc: _"Mọi socket event phải có TypeScript interface trong
     `shared/` trước khi implement"_. P0 làm interface, P5 mới viết gateway.
   - Danh sách event dự kiến ở [phụ lục cuối tài liệu](#phụ-lục--socket-event-contract).

4. **Hằng số permission bitfield**
   - Chép nguyên từ comment mục 4 của `nexus_schema.sql` thành `shared/permissions.ts`.
   - Viết sẵn hàm `computeEffectivePermissions()` + unit test, chưa gắn vào guard.
     Thuật toán: `base = OR(roles)` → nếu có `ADMINISTRATOR` thì allow tất cả →
     áp overwrite theo đúng thứ tự `@everyone → role → member`, mỗi bước
     `perms = (perms & ~deny) | allow`. **Sai thứ tự = user tự nâng quyền được.**

**Kiểm chứng:** `supabase db push` chạy sạch; `select count(*) from information_schema.tables
where table_schema='public'` trả 16; unit test permission pass; script check:shared pass.

---

### P1 — Dashboard shell

**Mục tiêu:** khung ba cột chạy được với dữ liệu giả. Đây là thứ Profile và Setting
gắn vào, nên phải xong sớm.

**Chức năng nhỏ**

1. **Layout ba cột** (theo `DESIGN-voltagent.md`)
   - Cột 1 — _server rail_: dải icon server dọc trái, hẹp.
   - Cột 2 — _channel list_: tên server + danh sách kênh + khu người dùng dưới đáy.
   - Cột 3 — _main_: nội dung, nơi các trang khác render vào.
2. **Routing khung**
   - `/channels/:serverId/:channelId` — kênh trong server
   - `/channels/@me` — danh sách DM
   - `/channels/@me/:conversationId` — một cuộc trò chuyện riêng
   - Trang Profile / Setting render vào cột 3 qua router outlet của shell.
3. **Trạng thái rỗng** cho từng vùng ("Chưa có server nào", "Chọn một kênh để bắt đầu").
4. **Responsive**: dưới `lg` thì cột 1+2 thu vào drawer.
5. **A11y**: điều hướng bàn phím giữa ba cột, `aria-current` cho kênh đang mở.

**Điểm kỹ thuật**

- Dùng `ex-app-shell-row` trong design system: hàng sidebar, trạng thái active dùng
  `primary` làm indicator. Màu xanh `#00d992` **chỉ** dành cho CTA và chỉ báo trạng
  thái sống — không dùng làm màu chữ body.
- Component nhỏ, `OnPush`, state bằng signal (luật trong `nexus-fe/.claude/CLAUDE.md`).

**Kiểm chứng:** vào `/channels/@me` thấy đủ ba cột; thu nhỏ cửa sổ thì cột 1+2 gập lại;
test AXE không lỗi.

---

### P2 — Server & Channel (chỉ đọc)

**Mục tiêu:** sidebar hiển thị dữ liệu thật.

**Chức năng nhỏ**

1. `GET /api/servers` — các server user đang tham gia (join `server_members`).
2. `GET /api/servers/:id/channels` — kênh của server, sắp theo `position`.
3. `PermissionsGuard` — gắn thật vào route, lọc kênh user không có `VIEW_CHANNEL`.
4. Sidebar hiển thị server rail + channel list từ API.
5. Chọn kênh → đổi route → cột 3 hiện tên kênh và `topic`.
6. Tạo server / tạo kênh ở mức tối thiểu (đủ để có dữ liệu mà test).
   - `ServerService.create()` phải gọi `create_default_role()` **trong cùng
     transaction** với insert server + insert owner vào `server_members`.

**Điểm kỹ thuật**

- Kênh `is_private` và `channel_overwrites` áp dụng ngay ở tầng lọc, đừng để tới P7
  mới thêm — sửa sau sẽ phải rà lại mọi endpoint.
- Phần **sửa/xoá server, kênh, RBAC UI, invite link** thuộc trang Setting, không làm ở đây.

**Kiểm chứng:** tạo 2 server, mỗi server 3 kênh; sidebar hiện đúng; user không phải
thành viên gọi API trả 403.

---

### P3 — Đọc tin nhắn ★

**Mục tiêu:** mở một kênh và đọc được lịch sử, cuộn ngược lên tải thêm.

**Chức năng nhỏ**

1. **`GET /api/channels/:id/messages?before=<cursor>&limit=50`**
   ```sql
   SELECT * FROM messages
   WHERE channel_id = $1 AND deleted_at IS NULL OR deleted_at IS NOT NULL
     AND id < $cursor
   ORDER BY id DESC LIMIT 50;
   ```
   Dùng index `idx_messages_channel_cursor`. **Cấm `OFFSET`.**
2. **Cuộn ngược vô hạn** — chạm đầu danh sách thì tải tiếp bằng `before = id nhỏ nhất`.
3. **Giữ vị trí cuộn** khi chèn tin cũ vào đầu (nếu không màn hình sẽ nhảy).
4. **Gom tin liên tiếp** cùng tác giả trong vài phút thành một khối, chỉ hiện avatar
   và tên ở tin đầu.
5. **Tin đã xoá** (`deleted_at` khác null) hiển thị "Tin nhắn đã bị xoá", không ẩn hẳn.
6. **Tin hệ thống** (`system_join` / `system_leave`) render khác tin thường.
7. **Dấu phân cách ngày** giữa các ngày khác nhau.
8. Timestamp lưu UTC, format ở tầng hiển thị (luật `CLAUDE.md`).

**Điểm kỹ thuật**

- `messages.id` là `bigint` — trong JS vượt `Number.MAX_SAFE_INTEGER` về lý thuyết.
  Ở quy mô đồ án thì không chạm tới, nhưng **truyền cursor dưới dạng chuỗi** để
  không phải sửa lại sau.
- `author_id` có thể null (`on delete set null`) → UI phải chịu được "Người dùng đã xoá".

**Kiểm chứng:** seed 200 tin vào một kênh, cuộn ngược tới đầu, kiểm tra không tin nào
lặp và không tin nào mất; xem query plan xác nhận có dùng index.

---

### P4 — Gửi tin nhắn

**Mục tiêu:** gõ và gửi được, tin hiện ngay lập tức.

**Chức năng nhỏ**

1. **`POST /api/channels/:id/messages`** — body gồm `content`, `client_nonce`, `reply_to_id?`.
2. **`client_nonce`** — client sinh uuid v4 **trước khi** gửi. Unique index
   `(author_id, client_nonce)` chặn ghi trùng khi retry.
3. **Optimistic UI** — vẽ tin ngay với trạng thái "đang gửi", thay bằng bản thật khi
   server trả về, đối chiếu bằng `client_nonce`.
4. **Gửi thất bại** — hiện trạng thái lỗi kèm nút thử lại, **giữ nguyên `client_nonce` cũ**
   (sinh nonce mới sẽ tạo tin trùng).
5. **Kiểm tra quyền** `SEND_MESSAGES` trong guard.
6. **Giới hạn** `content` 4000 ký tự, chặn cả ở form và DTO.
7. **Ô soạn thảo**: Enter gửi, Shift+Enter xuống dòng, tự giãn chiều cao.

**Điểm kỹ thuật**

- **Gửi bằng REST, không bằng socket.** Socket chỉ dùng để _nhận_ (P5). Lý do: REST có
  mã lỗi rõ ràng, retry và xác thực đơn giản; nếu gửi qua socket thì phải tự làm lại
  toàn bộ cơ chế ack/timeout. Server ghi DB xong mới broadcast.
- Khi gặp lỗi unique `client_nonce`, trả về **tin đã tồn tại** kèm 200 chứ không phải
  409 — client retry sau khi server đã ghi thành công là chuyện bình thường.

**Kiểm chứng:** gửi tin khi tắt mạng → thấy trạng thái lỗi; bật lại mạng, bấm thử lại
→ chỉ có đúng một tin trong DB.

---

### P5 — Realtime socket ★

**Mục tiêu:** hai tab thấy tin của nhau tức thì, và không mất tin khi rớt mạng.

**Chức năng nhỏ**

1. **Gateway NestJS + Socket.IO**, xác thực bằng access token Supabase ngay ở handshake
   (dùng lại cách của `SupabaseAuthGuard`). Token sai → từ chối kết nối.
2. **Room** — `channel:<uuid>` cho mỗi kênh, `user:<uuid>` cho thông báo riêng.
   Vào kênh thì join, rời thì leave.
3. **Nhận tin mới** — `message:new` broadcast tới room sau khi P4 ghi DB xong.
4. **Reconnect resync** ★ — client nhớ `id` tin cuối cùng đã nhận của mỗi kênh đang mở;
   khi socket kết nối lại thì gọi `GET /api/channels/:id/messages?after=<lastId>`
   để lấy phần bị miss. **Không có bước này thì mất mạng 3 giây là mất tin vĩnh viễn.**
5. **Trạng thái kết nối** hiển thị cho user ("Đang kết nối lại…").
6. **Đang gõ** — `typing:start` / `typing:stop`, tự tắt sau vài giây.
7. **Chống tự nhận** — người gửi đã có tin từ optimistic UI, phải khử trùng bằng
   `client_nonce` khi `message:new` của chính mình quay về.

**Điểm kỹ thuật**

- Cần thêm tham số `after` cho endpoint P3 (quét xuôi, `id > $after ORDER BY id ASC`).
- Presence và Redis: `NEXUS_CONTEXT.md` §8 đã kết luận **in-memory Map là đủ khi chỉ
  chạy 1 instance NestJS**. Chỉ cần `socket.io-redis` khi scale nhiều instance.
- ⚠️ Deploy target còn treo. Render free tier ngủ sau 15 phút → **đứt websocket**.
  Cần chốt trước khi demo (§8).

**Kiểm chứng:** mở 2 tab, gửi tin ở tab A → tab B hiện ngay. Tắt mạng tab B 30 giây,
gửi 5 tin ở tab A, bật mạng lại → tab B nhận đủ 5 tin, không trùng, đúng thứ tự.

---

### P6 — Read state & badge unread ★

**Mục tiêu:** biết kênh nào có tin chưa đọc.

**Chức năng nhỏ**

1. **`PUT /api/channels/:id/read-state`** — cập nhật `last_read_message_id` khi user
   xem tới cuối kênh.
2. **Đếm chưa đọc** — luôn tính từ bảng, không đếm trong memory:
   ```sql
   SELECT count(*) FROM messages
   WHERE channel_id = $1 AND id > (
     SELECT last_read_message_id FROM read_states
     WHERE user_id = $2 AND channel_id = $1
   );
   ```
3. **Badge trên sidebar** — chấm cho kênh có tin mới, số cho lượt nhắc tên (`mention_count`).
4. **Vạch "Tin chưa đọc"** chèn vào đúng vị trí trong danh sách tin.
5. **Cập nhật realtime** — nhận `message:new` ở kênh không mở thì tăng badge.

**Điểm kỹ thuật**

- `read_states` **không có primary key**, chỉ có hai partial unique index. Khi `upsert`
  phải chỉ rõ conflict target (`user_id, channel_id`), không dùng mặc định được.
- Mở tab thứ hai phải ra cùng kết quả — đây chính là lý do cấm đếm trong memory.

**Kiểm chứng:** mở 2 tab, đọc hết ở tab A → badge ở tab B biến mất sau khi F5.

---

### P7 — Sửa / xoá / trả lời

1. Sửa tin của mình → set `edited_at`, UI hiện nhãn "đã chỉnh sửa".
2. Xoá mềm → set `deleted_at`, giữ dòng lại (P3 đã render sẵn).
3. Xoá tin người khác → cần quyền `MANAGE_MESSAGES`.
4. Trả lời (`reply_to_id`) → hiện trích dẫn ngắn phía trên, bấm vào thì nhảy tới tin gốc.
5. Broadcast `message:updated` / `message:deleted`.

---

### P8 — Đính kèm file & ảnh

1. Upload lên Supabase Storage, lưu `storage_path` vào bảng `attachments`.
2. Kéo-thả và dán ảnh từ clipboard.
3. Xem trước ảnh/video kèm `width`/`height` (tránh nhảy layout khi ảnh tải xong).
4. Quyền `ATTACH_FILES`.
5. Giới hạn dung lượng và kiểu file, chặn ở cả hai tầng.
6. Tin chỉ có ảnh (content rỗng) — hợp lệ, nhưng **service layer phải tự kiểm tra**
   vì ràng buộc DB không nhìn được sang bảng `attachments`.

---

### P9 — Tin nhắn riêng (DM 1-1)

1. `conversations` + `conversation_participants`, `type = 'dm'`.
2. **`dm_key`** do NestJS sinh: `uuid nhỏ hơn + ':' + uuid lớn hơn`. Unique index chặn
   tạo trùng phòng giữa cùng hai người.
3. Danh sách DM ở `/channels/@me`.
4. Dùng lại toàn bộ P3–P7, chỉ đổi `channel_id` thành `conversation_id`.
5. Group DM là **mục cắt số 5** — chỉ làm nếu còn thời gian.

---

### P10 — Sticker _(cắt được — §7 #4)_

1. Proxy qua NestJS, **API key Giphy/Tenor giữ ở backend**.
2. Lưu `sticker_provider` + `sticker_id` + `sticker_url`. **Không tải ảnh về Storage.**
3. Hiển thị attribution theo điều khoản nhà cung cấp.
4. Nhà cung cấp (Giphy hay Tenor) còn treo ở §8.

---

### P11 — Thông báo in-app

1. Chỉ in-app: socket event + badge. **Không** push, **không** service worker, **không** FCM.
2. Nhận diện `@mention` khi gửi → tăng `mention_count` trong `read_states`.
3. Ghi bảng `notifications`, phát qua room `user:<uuid>`.
4. Trung tâm thông báo, đánh dấu đã đọc (`read_at`).

---

## B. Gọi thoại — 5 phase

**Đã chốt 31/07: audio thật, dùng LiveKit Cloud.** Xem `NEXUS_CONTEXT.md` §3.5.

Tin tốt: **không cần thêm bảng nào**. LiveKit tự giữ danh sách người trong phòng, và
bitfield trong `nexus_schema.sql` đã có sẵn `CONNECT_VOICE` (1<<10) và `SPEAK_VOICE` (1<<11).

### Bảng tổng quan

| Phase  | Nội dung                                      | Ước lượng | Phụ thuộc  |
| ------ | --------------------------------------------- | --------- | ---------- |
| **C1** | Nền móng LiveKit + endpoint phát token        | 0.5 ngày  | P0         |
| **C2** | Voice channel: vào/ra, nghe/nói, tắt mic      | 1.5 ngày  | C1, P2     |
| **C3** | Chỉ báo trạng thái: ai đang nói, mic/tai nghe | 0.5 ngày  | C2         |
| **C4** | Gọi riêng 1-1 trong DM: chuông, nhận/từ chối  | 1.5 ngày  | C2, **P9** |
| **C5** | Video + chia sẻ màn hình _(cắt được)_         | 1 ngày    | C2         |

---

### C1 — Nền móng LiveKit

1. Tạo tài khoản **LiveKit Cloud**, lấy `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
2. **API secret chỉ nằm trong `.env` của NestJS.** Không bao giờ vào bundle Angular —
   cùng nguyên tắc với `service_role` ở §3.2.
3. **`POST /api/voice/token`** — nhận `{ roomName }`, trả token đã ký:
   - Kiểm tra `CONNECT_VOICE` trước khi phát token. Không có quyền → 403, **không phát**.
   - `SPEAK_VOICE` quyết định token có quyền publish hay chỉ subscribe (vào nghe nhưng
     không nói được).
   - Token đặt hạn ngắn (vài phút), client xin lại khi cần.
4. Ánh xạ tên phòng: `voice:<channelId>` · `dm:<conversationId>`.
5. Cài `livekit-server-sdk` (BE) và `livekit-client` (FE).

**Kiểm chứng:** gọi endpoint bằng tài khoản không có `CONNECT_VOICE` → 403; có quyền →
token giải mã ra đúng room và đúng quyền publish.

---

### C2 — Voice channel

1. Bấm vào kênh `type = 'voice'` → xin token → vào phòng LiveKit.
2. **Danh sách người trong kênh** hiển thị ngay dưới tên kênh ở sidebar, thấy được cả
   khi mình không ở trong kênh đó.
3. **Nghe và nói thật**: publish track micro, subscribe track của người khác.
4. **Thanh điều khiển**: tắt/bật mic, tắt/bật loa (deafen), rời kênh.
5. **Xin quyền micro của trình duyệt** — xử lý tử tế khi người dùng từ chối.
6. Rời kênh, đóng tab, mất mạng → phải dọn sạch, không để lại "người ma" trong danh sách.

**Điểm kỹ thuật**

- Danh sách người lấy từ **sự kiện của LiveKit**, không tự đếm bằng Socket.IO — hai
  nguồn sẽ lệch nhau ngay khi có người rớt mạng.
- Nhưng vẫn phải phát sự kiện qua socket để **người ngoài kênh** thấy được ai đang ở
  trong đó (họ không ở trong phòng LiveKit nên không nhận được sự kiện của nó).
- Vào một voice channel khác phải tự rời phòng cũ.

**Kiểm chứng:** hai máy (hoặc hai trình duyệt khác nhau) cùng vào một kênh, nghe được
tiếng nhau. Đóng đột ngột một tab → tên biến khỏi danh sách bên kia trong vài giây.

---

### C3 — Chỉ báo trạng thái

1. **Ai đang nói** — viền sáng quanh avatar, lấy từ sự kiện active-speaker của LiveKit.
2. Biểu tượng mic tắt / loa tắt cạnh mỗi người.
3. Đồng bộ trạng thái này ra sidebar cho người ngoài kênh.
4. Màu xanh `#00d992` dùng làm chỉ báo "đang nói" — đúng luật design system: xanh chỉ
   dành cho CTA và **chỉ báo trạng thái sống**.

---

### C4 — Gọi riêng 1-1 _(cần P9 xong trước)_

1. Nút gọi trong cửa sổ DM.
2. **Chuông**: phát `call:incoming` qua room `user:<uuid>` của người nhận.
3. Nhận / Từ chối / Hết giờ tự huỷ (khoảng 30 giây).
4. Đang gọi: hiện thời lượng, tắt mic, kết thúc.
5. Ghi vào lịch sử hội thoại: "Cuộc gọi thoại · 3 phút" hoặc "Cuộc gọi nhỡ" —
   dùng `messages.type` mở rộng, hoặc thêm bảng `call_logs` nếu cần chi tiết hơn.
6. Xử lý các ca lệch: hai bên gọi nhau cùng lúc, người nhận đang bận ở cuộc khác.

---

### C5 — Video & chia sẻ màn hình _(cắt được)_

1. Bật/tắt camera, lưới hiển thị video.
2. Chia sẻ màn hình (một track riêng trong LiveKit).
3. Chọn thiết bị vào/ra (mic, loa, camera).

Đây là mục **nên cắt đầu tiên** nếu thiếu thời gian — chức năng gọi vẫn trọn vẹn khi
chỉ có tiếng.

---

## Phụ lục — Socket event contract

Bản nháp cho P0. Interface thật đặt ở `shared/socket-events.ts`.

**Client → Server**

| Event           | Payload         | Dùng ở |
| --------------- | --------------- | ------ |
| `channel:join`  | `{ channelId }` | P5     |
| `channel:leave` | `{ channelId }` | P5     |
| `typing:start`  | `{ channelId }` | P5     |
| `typing:stop`   | `{ channelId }` | P5     |

**Server → Client**

| Event                                            | Payload                                    | Dùng ở |
| ------------------------------------------------ | ------------------------------------------ | ------ |
| `message:new`                                    | `{ message }`                              | P5     |
| `message:updated`                                | `{ message }`                              | P7     |
| `message:deleted`                                | `{ channelId, messageId }`                 | P7     |
| `typing:update`                                  | `{ channelId, userIds }`                   | P5     |
| `unread:update`                                  | `{ channelId, unreadCount, mentionCount }` | P6     |
| `notification:new`                               | `{ notification }`                         | P11    |
| `voice:participants`                             | `{ channelId, users }`                     | C2     |
| `call:incoming`                                  | `{ conversationId, fromUserId }`           | C4     |
| `call:answered` / `call:declined` / `call:ended` | `{ conversationId }`                       | C4     |

Hai thứ **không** đi qua socket:

- **Gửi tin nhắn** — dùng `POST /api/channels/:id/messages` (lý do ở P4).
- **Trạng thái trong phòng gọi** — lấy từ sự kiện của LiveKit. Các event `voice:*` ở
  trên chỉ để **người ngoài phòng** thấy ai đang trong đó; người trong phòng luôn tin
  LiveKit, không tin socket (lý do ở C2).
