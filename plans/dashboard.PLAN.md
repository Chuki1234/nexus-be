# Dashboard — Kế hoạch triển khai

> Bản kế hoạch cho trang Dashboard. Mọi quyết định ở đây phải khớp với
> [`NEXUS_CONTEXT.md`](NEXUS_CONTEXT.md) — nếu lệch thì `NEXUS_CONTEXT.md` thắng.
>
> Lập ngày: 31/07/2026 · Còn 16 ngày tới hạn 16/08 · Mốc kiểm tra 08/08 (còn 8 ngày)

---

## Phạm vi

Dashboard chia làm hai mảng lớn:

| Mảng | Số phase | Ước lượng |
|---|---|---|
| **A. Nhắn tin** (chat message) | P0 – P11 | ~14.5 ngày |
| **B. Gọi thoại** (live calling, LiveKit Cloud) | C1 – C5 | ~4.5 ngày |
| | **Tổng** | **~19 ngày** |

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

| Yêu cầu | Nằm ở phase | Vì sao không cắt được |
|---|---|---|
| Cursor pagination (cấm `OFFSET`) | P3 | `OFFSET` chậm dần theo độ sâu, và trả sai khi có tin mới chèn vào giữa |
| Read state đọc từ bảng `read_states` | P6 | Biến đếm trong memory sai ngay khi user F5 hoặc mở tab thứ hai |
| Socket reconnect resync | P5 | Mất mạng 3 giây là mất tin vĩnh viễn nếu không resync |

---

## A. Nhắn tin — 12 phase

Mỗi phase phải **chạy được và kiểm chứng được** trước khi sang phase sau.

### Bảng tổng quan

| Phase | Nội dung | Ước lượng | Ghi chú |
|---|---|---|---|
| **P0** | Nền móng: schema, `shared/`, socket contract | 1.5 ngày | Chặn tất cả |
| **P1** | Dashboard shell | 1 ngày | Chặn Profile + Setting |
| **P2** | Server & Channel (đọc) | 1 ngày | |
| **P3** | Đọc tin nhắn + cursor pagination | 1.5 ngày | ★ không cắt |
| **P4** | Gửi tin + optimistic UI | 1 ngày | |
| **P5** | Realtime socket + reconnect resync | 2 ngày | ★ không cắt |
| **P6** | Read state + badge unread | 1 ngày | ★ không cắt |
| | — **Hết Messaging Core, mốc 08/08** — | **9 ngày** | ⚠️ chỉ có 8 ngày |
| **P7** | Sửa / xoá / trả lời tin | 1 ngày | |
| **P8** | Đính kèm file & ảnh | 1.5 ngày | |
| **P9** | Tin nhắn riêng (DM 1-1) | 1.5 ngày | |
| **P10** | Sticker | 0.5 ngày | Cắt được (§7 #4) |
| **P11** | Thông báo in-app + mention | 1 ngày | |

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

     | Việc | Chi tiết |
     |---|---|
     | Đổi tên cột | `birthdate` → `date_of_birth` |
     | Đổi kiểu | `email`, `username`: `text` → `citext` |
     | Thêm cột | `phone`, `avatar_url`, `banner_url`, `status_message`, `manual_presence`, `last_seen_at` |
     | Giữ nguyên | Regex username **`{3,32}`** — sửa `nexus_schema.sql` từ `{2,32}` xuống cho khớp |

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
   - `CLAUDE.md` gốc: *"Mọi socket event phải có TypeScript interface trong
     `shared/` trước khi implement"*. P0 làm interface, P5 mới viết gateway.
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
   - Cột 1 — *server rail*: dải icon server dọc trái, hẹp.
   - Cột 2 — *channel list*: tên server + danh sách kênh + khu người dùng dưới đáy.
   - Cột 3 — *main*: nội dung, nơi các trang khác render vào.
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
- **Gửi bằng REST, không bằng socket.** Socket chỉ dùng để *nhận* (P5). Lý do: REST có
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

### P10 — Sticker *(cắt được — §7 #4)*

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

| Phase | Nội dung | Ước lượng | Phụ thuộc |
|---|---|---|---|
| **C1** | Nền móng LiveKit + endpoint phát token | 0.5 ngày | P0 |
| **C2** | Voice channel: vào/ra, nghe/nói, tắt mic | 1.5 ngày | C1, P2 |
| **C3** | Chỉ báo trạng thái: ai đang nói, mic/tai nghe | 0.5 ngày | C2 |
| **C4** | Gọi riêng 1-1 trong DM: chuông, nhận/từ chối | 1.5 ngày | C2, **P9** |
| **C5** | Video + chia sẻ màn hình *(cắt được)* | 1 ngày | C2 |

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

### C4 — Gọi riêng 1-1 *(cần P9 xong trước)*

1. Nút gọi trong cửa sổ DM.
2. **Chuông**: phát `call:incoming` qua room `user:<uuid>` của người nhận.
3. Nhận / Từ chối / Hết giờ tự huỷ (khoảng 30 giây).
4. Đang gọi: hiện thời lượng, tắt mic, kết thúc.
5. Ghi vào lịch sử hội thoại: "Cuộc gọi thoại · 3 phút" hoặc "Cuộc gọi nhỡ" —
   dùng `messages.type` mở rộng, hoặc thêm bảng `call_logs` nếu cần chi tiết hơn.
6. Xử lý các ca lệch: hai bên gọi nhau cùng lúc, người nhận đang bận ở cuộc khác.

---

### C5 — Video & chia sẻ màn hình *(cắt được)*

1. Bật/tắt camera, lưới hiển thị video.
2. Chia sẻ màn hình (một track riêng trong LiveKit).
3. Chọn thiết bị vào/ra (mic, loa, camera).

Đây là mục **nên cắt đầu tiên** nếu thiếu thời gian — chức năng gọi vẫn trọn vẹn khi
chỉ có tiếng.

---

## Phụ lục — Socket event contract

Bản nháp cho P0. Interface thật đặt ở `shared/socket-events.ts`.

**Client → Server**

| Event | Payload | Dùng ở |
|---|---|---|
| `channel:join` | `{ channelId }` | P5 |
| `channel:leave` | `{ channelId }` | P5 |
| `typing:start` | `{ channelId }` | P5 |
| `typing:stop` | `{ channelId }` | P5 |

**Server → Client**

| Event | Payload | Dùng ở |
|---|---|---|
| `message:new` | `{ message }` | P5 |
| `message:updated` | `{ message }` | P7 |
| `message:deleted` | `{ channelId, messageId }` | P7 |
| `typing:update` | `{ channelId, userIds }` | P5 |
| `unread:update` | `{ channelId, unreadCount, mentionCount }` | P6 |
| `notification:new` | `{ notification }` | P11 |
| `voice:participants` | `{ channelId, users }` | C2 |
| `call:incoming` | `{ conversationId, fromUserId }` | C4 |
| `call:answered` / `call:declined` / `call:ended` | `{ conversationId }` | C4 |

Hai thứ **không** đi qua socket:
- **Gửi tin nhắn** — dùng `POST /api/channels/:id/messages` (lý do ở P4).
- **Trạng thái trong phòng gọi** — lấy từ sự kiện của LiveKit. Các event `voice:*` ở
  trên chỉ để **người ngoài phòng** thấy ai đang trong đó; người trong phòng luôn tin
  LiveKit, không tin socket (lý do ở C2).
