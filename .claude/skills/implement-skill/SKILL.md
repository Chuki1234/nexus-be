---
name: implement-skill
description: >
  Quy trình bắt buộc khi dùng AI coding agent để code cho project Nexus (lớp 246) hoặc Fizzle
  (lớp 357) — 2 project chat app kiểu Discord (Angular 21 + NestJS + Supabase) cho member mới
  học code, mỗi người phụ trách 1-2 trang. Gọi bằng /implement-skill hoặc tự kích hoạt bất cứ
  khi nào member yêu cầu implement/code/sửa một trang hoặc chức năng, vd "code giúp mình trang
  login", "làm chức năng chat cho dashboard", "tiếp tục phase 2 của profile". Bắt buộc: kiểm
  tra nhánh git, lập plan theo phase và chờ member duyệt bằng văn bản trước khi code, scaffold
  bằng Angular CLI/Nest CLI đúng cấu trúc quy định, compile-check trước khi cho test, debug
  bằng dev server thật, viết test E2E bằng Playwright, đánh giá kết quả theo 3 tiêu chí UI/UX
  – Feature – Data, rồi mới commit/push lên đúng nhánh và tạo Pull Request bằng GitHub CLI cho
  mentor duyệt. Không bỏ qua bước nào kể cả khi member yêu cầu code ngay.
---

# Implement Skill — Nexus & Fizzle — quy trình phát triển bắt buộc

Skill này áp dụng cho hai project của mentor Luke: **Nexus** (lớp 246) và **Fizzle** (lớp 357).
Cả hai đều là chat app kiểu Discord, dùng Angular 21 + NestJS + Supabase, mỗi member phụ trách
một hoặc vài "trang" (page) cụ thể trên nhánh git riêng của mình.

Lý do quy trình này tồn tại: đây là bài tập để member **học cách làm việc có kỷ luật** — tách
việc rõ ràng theo trang, có kế hoạch được duyệt trước khi code, có test, có lịch sử git sạch.
Agent bỏ qua bước nào (code trước khi duyệt plan, gộp nhiều trang vào một chỗ, push nhầm nhánh…)
là làm hỏng chính mục đích của bài tập, dù code cuối cùng có chạy đúng. Vì vậy hãy coi các bước
dưới đây là trình tự bắt buộc, không phải gợi ý.

## Member là newbie — agent phải vừa làm vừa dạy
Hầu hết member chưa quen code hay các stack trong docs (Socket.IO, Redis, CASL, v.v.). Khi
scaffold hoặc code, đừng chỉ lặng lẽ sinh ra file — **giải thích ngắn gọn (1-2 câu) lý do** mỗi
khi làm một việc có thể mới với người mới học, vd "mình tạo DTO ở đây để tự động kiểm tra dữ
liệu đầu vào trước khi vào service, tránh dữ liệu rác/độc hại lọt vào DB". Không cần giảng dài
dòng, chỉ cần đủ để member dần hiểu mình đang làm gì và tại sao — đây cũng là mục đích của bài
tập, không chỉ để có code chạy được.

## Ba tiêu chí chất lượng bắt buộc — dùng để lập plan, test, và tổng kết
Mọi phase, mọi lần test, và bản tổng kết cuối trang đều phải đánh giá theo đúng 3 tiêu chí sau
(mentor Luke đặt ra để member biết "làm xong" nghĩa là gì, không chỉ là "chạy được"):

1. **UI/UX** — đạt mức tối thiểu là bám theo **file Design System có sẵn trong repo FE** (đây
   là chuẩn cao nhất, luôn ưu tiên). Ngay từ đầu phiên FE, tìm và đọc file design system này
   (thường ở `src/styles/`, `src/app/shared/`, hoặc file `DESIGN_SYSTEM.md`/`design-system.*`,
   `styles.scss`, theme tokens) — nếu không tìm thấy, hỏi member đường dẫn, đừng tự bịa style.
   Trên nền đó:
   - **Component chính dùng Angular Material** (`mat-button`, `mat-form-field`, `mat-dialog`,
     `mat-menu`, `mat-tabs`...). Các component trong `shared/ui/` đóng vai trò **wrap lại
     Material** để áp đúng token/design system và giữ nhất quán — ưu tiên gọi qua `shared/ui/`
     nếu wrapper đã có, còn khi dựng UI mới thì dựa trên Material chứ không tự code control từ đầu.
   - **Icon dùng Angular Material icon + Google Fonts** (`mat-icon` với Material Symbols/Icons
     nạp qua Google Fonts) — không chèn SVG/PNG icon rời rạc tuỳ tiện.
   - Theme nhất quán với layout Discord-clone đã có; đủ trạng thái loading/empty/error (không để
     trắng trang khi đang tải hoặc lỗi); không hardcode màu/spacing ngoài token của design system.
2. **Feature** — đầy đủ theo đúng danh sách Feature của trang trong `reference/plan-nexus.md` /
   `reference/plan-fizzle.md`. Core stack (Socket.IO, Redis, WebRTC, CASL...) chỉ là **gợi ý**,
   không bắt buộc dùng đúng y chang — miễn feature hoạt động đúng hành vi mong đợi, dùng cách
   khác cũng được, nhưng phải ghi rõ lý do lựa chọn khác trong PLAN.md để mentor hiểu khi review.
3. **Data** — server quản lý dữ liệu hợp lý và logic: DTO/validate đầy đủ mọi input (không tin
   tưởng dữ liệu từ client dù FE đã validate rồi), truy vấn/quan hệ DB đúng (không trùng lặp dữ
   liệu, không N+1 query), không trả field nhạy cảm (password hash, token) ra API response, trả
   đúng mã lỗi HTTP theo tình huống (400/401/403/404) thay vì để lỗi 500 chung chung. **Member
   KHÔNG được tự thay đổi cấu trúc database — xem quy tắc "Quản lý Database" ngay bên dưới.**

Ba tiêu chí này được dùng ở: Bước 2 (mỗi phase nên gắn rõ với 1+ tiêu chí), Bước 6 (test và ghi
kết quả theo từng tiêu chí, không chỉ pass/fail chung chung), và Bước 9 (tổng kết cả trang sau
khi xong hết các phase).

## Quản lý Database — member KHÔNG tự đụng vào schema, mentor mới là người tạo bảng
Database dùng chung cho cả team nên phải do một mình mentor Luke kiểm soát cấu trúc — member
**không được tự thêm/xoá/sửa bảng, cột, hay bất kỳ thay đổi schema nào** trực tiếp trên Supabase.
Quy trình bắt buộc khi một phase cần bảng/cột mới:

1. Agent **không** chạy DDL trực tiếp lên Supabase, **không** dùng công cụ migration tự áp
   (vd `supabase db push`, `prisma migrate deploy`, TypeORM `synchronize: true`...) để đổi schema.
2. Thay vào đó, agent viết file migration SQL vào **`backend/migrations/<timestamp>_<mo-ta>.sql`**
   (vd `backend/migrations/20260806_create_messages_table.sql`) chứa lệnh `CREATE TABLE` /
   `ALTER TABLE`... đầy đủ và rõ ràng, kèm comment giải thích ngắn để member (newbie) hiểu bảng
   này để làm gì. Commit file này vào repo BE như một phần của phase (đi cùng nhánh/PR của trang).
3. Báo member: "Mình đã tạo file migration `<đường dẫn>`, bạn gửi file này cho mentor để mentor
   chạy tạo bảng trên Supabase. Khi nào mentor báo đã tạo xong thì mình mới nối code vào bảng đó."
4. **Chờ mentor xác nhận đã tạo bảng** rồi agent mới viết phần code kết nối (service query, entity
   mapping, repository...) trỏ tới **đúng bảng/cột đã tồn tại** trên Supabase — chỉ setup kết nối
   và đọc/ghi dữ liệu, tuyệt đối không tự tạo lại schema từ code.
5. Nếu code cần chạy thử mà bảng chưa được mentor tạo, phần liên quan tới bảng đó tạm coi là
   "chờ DB" trong PLAN.md (ghi rõ ở mục Kết quả phase), không đánh dấu phase DONE cho tới khi bảng
   thật sự có và code nối vào chạy được.

## Cài đặt skill — bắt buộc ở CẢ HAI repo
Copy thư mục skill này vào `.claude/skills/implement-skill/` ở **cả frontend lẫn backend**,
không chỉ ở root workspace. Lý do: member có thể mở riêng từng repo trong VS Code (không mở
root workspace chứa cả hai) — nếu skill chỉ nằm ở root, phiên làm việc mở riêng 1 repo sẽ không
thấy skill và cũng có thể không có quyền đọc/ghi sang repo còn lại. Cài ở cả hai đảm bảo skill
luôn kích hoạt được dù member mở repo nào, kể cả khi gọi trực tiếp bằng `/implement-skill`.

## Cây thư mục chính thức
Mỗi project có cây thư mục riêng, dựng từ chính docs của project đó:
- **Fizzle** — `reference/folder-structure-fizzle-client.md`, `reference/folder-structure-fizzle-server.md`.
- **Nexus** — `reference/folder-structure-nexus-client.md`, `reference/folder-structure-nexus-server.md`
  (dựng riêng từ `plan_246`: server chỉ cá nhân/nhóm, có voice/video, ai-agent optional; không
  có livestream/community).

Hai project dùng chung kiến trúc Angular (`core`/`shared`/`layouts`/`features`) và NestJS
(`config`/`common`/`infra`/`modules`) nhưng danh sách feature/module khác nhau — luôn dùng đúng
file của project đã xác định ở Bước 0. Nếu mentor gửi bản cập nhật, thả vào
`docs/folder-structure-<project>-<client|server>.md` ở root workspace, skill ưu tiên bản đó (xem
Bước 3). Mỗi file tree có **bảng ownership** — map member nào sở hữu folder nào — dùng ở Bước 0
và Bước 3.

## Bối cảnh workspace
Root workspace của mỗi member chứa 2 repo riêng biệt, ngang hàng nhau (tên thư mục có thể khác
`frontend`/`backend`, đừng cứng nhắc theo tên — nhận diện bằng nội dung):

- **Client repo**: có `angular.json` / `package.json` với dependency `@angular/*` → Angular 21.
- **Server repo**: có `nest-cli.json` hoặc `package.json` với dependency `@nestjs/*` → NestJS.

Một "trang" (page) thường cần thay đổi ở CẢ HAI repo (UI ở client, API/logic ở server). Khi lập
plan và khi git add/commit/push, luôn cân nhắc cả hai repo, không chỉ repo đang mở.

## Quy ước đặt tên nhánh — skill tự tạo, mentor không cần tạo trước

Nhánh luôn có dạng **`pages/<ten-trang>/<ten-member>`** (vd `pages/profile/hoang-khang`,
`pages/auth/mon`, `pages/dashboard/minh-tai`). Đây là nhánh cho **một trang cụ thể** — member
phụ trách nhiều trang (Hoàng Khang, Khánh Hưng) sẽ có nhiều nhánh, mỗi trang một nhánh riêng,
tự nhiên vì tên trang nằm ngay trong tên nhánh.

**Nguyên tắc cách ly chống conflict**: mỗi trang = 1 nhánh, và member chỉ được đụng vào code
của trang mình phụ trách trên nhánh của trang đó. Tuyệt đối không sửa code trang của member
khác — đó là cách chính để nhiều người làm song song mà không xung đột git khi merge về `main`.
Chi tiết cách xử lý khi lỡ muốn đụng ngoài phạm vi xem Bước 3.

Mentor **không cần tạo nhánh trước** — agent tự tạo nhánh này ngay lần đầu implement một trang,
xem chi tiết ở Bước 7. Từ lần thứ hai trở đi (đã có nhánh, đã test qua ít nhất 1 phase), agent
**không tạo nhánh mới nữa** — chỉ commit và push tiếp lên đúng nhánh đã có.

## Bước 0 — Xác định danh tính & phạm vi (làm ở đầu MỌI phiên làm việc mới)

1. Trong repo hiện tại (và repo còn lại nếu agent có thể truy cập được), chạy
   `git branch --show-current`.
2. Nếu nhánh hiện tại đã đúng dạng `pages/<ten-trang>/<ten-member>` — đây là **phiên làm tiếp**
   (returning session): parse luôn `<ten-trang>` và `<ten-member>` từ tên nhánh, xác nhận
   `<ten-trang>` nằm trong danh sách chuẩn hoá (`auth`/`dashboard`/`profile`/`settings`/
   `livestream`/`ai-agent`) và `<ten-member>` khớp bảng Members — rồi chuyển sang Bước 2 luôn
   (bỏ qua phần hỏi identity, không cần tạo nhánh mới).
3. Nếu nhánh hiện tại KHÔNG theo dạng trên (vd đang ở `main`, hoặc một nhánh cũ/khác) — đây là
   **phiên đầu tiên cho một trang mới** (first-time). Xác định danh tính:
   - Nếu đã có `.claude/student-context.json` từ phiên trước (cùng member, có thể đang bắt đầu
     một trang khác) — dùng lại tên member đã biết, chỉ cần hỏi/xác nhận đang làm trang nào nếu
     chưa rõ.
   - Nếu chưa có gì — hỏi thẳng member họ là ai. So khớp tên (không phân biệt hoa/thường, bỏ
     qua dấu tiếng Việt, coi dấu gạch ngang/gạch dưới/khoảng trắng như nhau) với bảng Members
     trong `reference/plan-nexus.md` và `reference/plan-fizzle.md` để xác định project (Nexus
     hay Fizzle). Nếu không khớp tên nào — hỏi thẳng, không đoán bừa.
   - Xác định trang đang làm trong phiên này (xem Bước 1 nếu member phụ trách nhiều trang).
4. Xác nhận lại với member một câu ngắn gọn (vd: "Mình detect bạn là Minh Tài, project Nexus,
   phụ trách trang Dashboard — nhánh sẽ là pages/dashboard/minh-tai, đúng không?"), rồi lưu kết
   quả vào `.claude/student-context.json` **ở cả frontend lẫn backend** (mỗi repo tự giữ 1 bản)
   để các phiên sau không phải hỏi lại. Thêm file này vào `.gitignore` của cả hai repo nếu chưa
   có (đây là thông tin cục bộ, không cần lên git). Ghi nhớ đây là phiên first-time — nhánh
   `pages/<ten-trang>/<ten-member>` sẽ được tạo ở Bước 7, KHÔNG tạo ngay bây giờ — cứ tiếp tục
   Bước 1-6 bình thường trên nhánh hiện tại, các thay đổi (PLAN.md, code) sẽ tự động đi theo khi
   agent tạo nhánh mới ở Bước 7 (git giữ nguyên working-tree khi checkout -b).

## Bước 1 — Chọn trang/chức năng cho phiên làm việc này

Nếu đang là returning session (Bước 0 mục 2), trang đã rõ từ tên nhánh — dùng luôn. Nếu là
first-time và member chỉ được giao một trang, dùng luôn trang đó. Nếu được giao nhiều trang (vd
Hoàng Khang: Profile + Setting) và đang first-time, hỏi rõ đang làm trang nào trong phiên này.

## Bước 2 — Lập kế hoạch theo phase & chờ duyệt bằng văn bản (gate bắt buộc, không thương lượng)

**Trước khi tạo bất kỳ file code nào**, viết kế hoạch ra `plans/<ten-trang>.PLAN.md` **bên
trong MỖI repo** (tức `frontend/plans/<ten-trang>.PLAN.md` và `backend/plans/<ten-trang>.PLAN.md`
— không phải 1 file dùng chung ở root workspace), theo mẫu `templates/PLAN_TEMPLATE.md`, nội
dung giống hệt nhau ở cả hai bản. Lý do đặt ở cả hai thay vì một chỗ chung: mỗi repo commit riêng,
nên lịch sử duyệt/hoàn thành phase phải nằm trong git log của chính repo đó thì mới có ý nghĩa
khi mentor xem lại sau này. Chia nhỏ công việc thành các phase — mỗi phase đủ nhỏ để code +
test + commit gọn trong một buổi, có mục tiêu, file/folder dự kiến (cả client lẫn server: liệt
kê đủ trong CẢ HAI bản plan dù bản đó chỉ code 1 phía, để ai đọc cũng thấy toàn cảnh), tiêu chí
hoàn thành, và test case dự kiến. Tiêu chí hoàn thành của mỗi phase nên gắn rõ với 1 hoặc nhiều
trong **3 tiêu chí chất lượng** (UI/UX, Feature, Data — xem phần đầu file) thay vì chỉ ghi
chung chung "làm xong trang login" — vd "Feature: login bằng email/SĐT trả đúng lỗi khi sai mật
khẩu" hoặc "Data: DTO validate email đúng định dạng trước khi gọi Supabase Auth".

Sau khi ghi file (cả 2 bản), dừng lại và yêu cầu member **tự mở 1 trong 2 file, đọc, và sửa
dòng `Status:` của phase muốn duyệt thành `APPROVED`** — rồi agent tự đồng bộ thay đổi đó sang
bản còn lại (copy y hệt dòng Status, không tự diễn giải khác đi). Đây là lý do file thay vì chỉ
hỏi trong chat: nó để lại lịch sử duyệt trong repo, mentor xem lại sau này biết chính xác ai
duyệt cái gì lúc nào.

Trước khi viết code cho phase N, **luôn đọc lại `plans/<ten-trang>.PLAN.md` của repo đang code**
để xác nhận đúng chữ `Phase N: APPROVED` xuất hiện trong file. Nếu không thấy — kể cả khi member
vừa nói "ok làm đi" trong chat — vẫn dừng lại, nhắc member vào file sửa Status trước. Không tự
suy luận "chắc được duyệt rồi". Nếu hai bản plan bị lệch nhau (vd 1 bên đã sửa APPROVED, bên kia
chưa đồng bộ) — tự đồng bộ lại theo bản mới nhất trước khi tiếp tục, không hỏi member đồng bộ
tay.

## Bước 3 — Scaffold đúng folder theo ownership

Lưu ý quan trọng: "Page" của một member **không phải một folder đơn lẻ** — nó là một TẬP HỢP
các folder trong `features/` (client) và `modules/` (server) được liệt kê trong bảng ownership
của file tree tương ứng. Vd Minh Tài (Dashboard, Nexus) sở hữu cả `features/dashboard/`,
`features/servers/`, `features/voice/` bên client và 6 module tương ứng bên server — không chỉ
một folder tên "dashboard".

1. Xác định file tree đúng project (đã biết từ Bước 0):
   - Nexus: `reference/folder-structure-nexus-client.md`, `reference/folder-structure-nexus-server.md`.
   - Fizzle: `reference/folder-structure-fizzle-client.md`, `reference/folder-structure-fizzle-server.md`.
   - Nếu mentor đã thả bản cập nhật vào `docs/folder-structure-<project>-client.md` /
     `docs/folder-structure-<project>-server.md` ở root workspace, **ưu tiên bản đó**, coi file
     trong `reference/` là fallback.
2. Tra bảng ownership trong file tree để biết chính xác member này sở hữu những folder nào cho
   trang đang làm ở phase này.
3. Chỉ tạo/sửa file bên trong các folder thuộc phạm vi sở hữu của member, đúng những gì phase
   hiện tại cần — không tạo sẵn toàn bộ cây của cả trang, không đụng vào folder của member khác.
4. Nếu phase bắt buộc phải sửa phần dùng chung (`core/`, `shared/`, `layouts/` bên client;
   `common/`, `infra/`, `config/` bên server) — việc này phải đã được ghi rõ trong PLAN.md ở
   Bước 2 (không tự ý phát sinh giữa chừng), và phải báo cho member để họ biết báo lại nhóm.
5. **Nguyên tắc CLI bắt buộc — áp dụng cho MỌI loại file, không chỉ component/module**: bất kỳ
   loại file nào có sẵn schematic trong CLI của framework thì **phải tạo bằng CLI đó**, không
   được viết tay từ đầu. Repo client (Angular) → luôn dùng **Angular CLI**. Repo server (NestJS)
   → luôn dùng **Nest CLI**. Chỉ viết tay khi loại file đó KHÔNG có schematic tương ứng (vd DTO
   thuần, entity/model interface, file cấu hình, signal store tự định nghĩa) — những thứ này CLI
   không sinh ra được nên viết tay là bình thường, không phải ngoại lệ vi phạm nguyên tắc.

   - **Angular CLI** (`ng generate <schematic> <duong-dan/ten>`, viết tắt `ng g <schematic>
     <duong-dan/ten>`) — dùng cho mọi thứ có schematic: `component` (`c`), `service` (`s`),
     `directive` (`d`), `pipe` (`p`), `guard` (`g`), `interceptor`, `resolver`, `module` (`m`),
     `class`, `enum`... Thêm `--standalone` nếu dự án dùng standalone components. Vd tạo
     component `login-form`: `ng g c features/auth/login/components/login-form --standalone`.
   - **Nest CLI** (`nest generate <schematic> <duong-dan/ten>`, viết tắt `nest g <schematic>
     <duong-dan/ten>`) — dùng cho mọi thứ có schematic: `module` (`mo`), `controller` (`co`),
     `service` (`s`), `provider` (`pr`), `gateway` (`ga`), `filter` (`f`), `guard` (`gu`),
     `interceptor` (`in`), `pipe` (`pi`), `resource` (`res`), `middleware` (`mi`)...
   - Nếu không chắc CLI đang cài có đúng schematic/flag mình nghĩ không (version có thể khác
     giữa các máy), chạy `ng generate --help` hoặc `nest generate --help` trước để xem danh sách
     lệnh thật, **đừng đoán** rồi viết sai flag.

Tên trang dùng kebab-case, khớp với cột "Tên trang chuẩn hoá" trong `reference/plan-nexus.md`
/ `reference/plan-fizzle.md`.

### Khi member muốn code ngoài phạm vi được giao — phân biệt 3 trường hợp
Mục tiêu lớn nhất của việc phân nhánh theo trang (`pages/<ten-trang>/<ten-member>`) là **tránh
conflict git**: mỗi trang có nhánh riêng, mỗi member chỉ đụng vào code trang của mình, nên khi
nhiều người cùng làm song song thì các PR không đá nhau. Vì vậy xử lý khác nhau tuỳ folder mà
member muốn đụng vào:

**a) Trang của member KHÁC (folder đã có chủ trong bảng ownership) — KHÔNG được đụng, chặn cứng.**
Đây chính là nguồn conflict nguy hiểm nhất: hai người sửa cùng file trên hai nhánh khác nhau,
khi merge về `main` sẽ xung đột và dễ đè mất code của nhau. Nếu member yêu cầu sửa/tạo file
trong trang của người khác — **từ chối**, giải thích rõ folder này thuộc member nào và lý do
tránh conflict, rồi hướng họ: nếu thật sự cần thay đổi ở đó, báo mentor để mentor điều phối (mentor
sẽ giao cho đúng người phụ trách, hoặc quyết định cách xử lý). Agent **không tự code vào trang
người khác** dù member có khẳng định muốn làm — việc này khác với phần "làm thêm" ở mục (b) vì
nó đụng vào vùng đang có người khác động tới.

**b) Phần chưa ai nhận (không có chủ, vd `features/ai-agent/` bên Nexus) — cảnh báo rồi vẫn làm
nếu member khẳng định.** Vùng này không có ai khác đang làm nên không có rủi ro conflict. **Cảnh
báo rõ một lần** rằng phần này chưa được giao cho ai, hỏi member có chắc muốn làm không; nếu họ
xác nhận, cứ làm bình thường — vẫn đi đủ các bước Plan → Approve → Code → Test → Git như mọi
phase khác. (Nên tạo trên một nhánh trang riêng, vd `pages/ai-agent/<ten-member>`, để vẫn giữ
đúng nguyên tắc 1 trang = 1 nhánh.)

**c) Phần hạ tầng dùng chung** (`core/`, `shared/`, `layouts/` client; `common/`, `infra/`,
`config/` server) — xem mục 4 ở trên: được sửa nhưng phải khai trong PLAN.md và báo nhóm, vì
đây là vùng nhiều người cùng phụ thuộc, sửa ẩu cũng gây conflict/hỏng lan sang trang khác.

## Bước 4 — Code theo plan

Implement đúng theo mục tiêu và tiêu chí hoàn thành đã ghi trong phase đang duyệt. Nếu trong
lúc code phát hiện scope phase bị thiếu/thừa so với thực tế, quay lại sửa `PLAN.md` (thêm ghi
chú), báo member biết, không tự ý mở rộng sang phase khác mà chưa được duyệt.

Sau khi code xong phase, **compile-check trước khi cho member test** — đừng mở browser khi
chưa chắc code build được, member mới học dễ hoảng nếu thấy lỗi ngay khi mở trang:
- Client: `ng build` (hoặc theo dõi log lúc khởi động `ng serve` ở Bước 5).
- Server: `nest build` (hoặc theo dõi log lúc khởi động `nest start --watch`).
Nếu có lỗi compile — **báo cho member biết cụ thể lỗi gì** (đừng chỉ nói "có lỗi"), tự sửa, rồi
compile lại tới khi sạch lỗi. Nếu không có lỗi, chuyển sang Bước 5 để mở dev server cho member
test trực tiếp.

## Bước 5 — Debug trực tiếp cùng member

1. Khởi động dev server nếu chưa chạy: client thường `npm start` / `ng serve`, server thường
   `npm run start:dev` / `nest start --watch`. Đây cũng là lúc quan sát lại log để chắc chắn
   không còn lỗi compile nào lọt qua bước trước.
2. Cung cấp rõ URL localhost cho member (vd `http://localhost:4200`). Nếu agent có quyền chạy
   lệnh shell trên máy của member, có thể tự mở bằng `open <url>` (macOS) / `xdg-open <url>`
   (Linux) / `start <url>` (Windows) — nếu không chắc có quyền, chỉ cần in rõ URL và yêu cầu
   member tự mở.
3. Yêu cầu member thao tác thử trực tiếp trên browser và xác nhận flow đúng như mong đợi trước
   khi chuyển sang viết test tự động — test tự động không thay thế được việc member tự mắt thấy
   UI chạy đúng.

## Bước 6 — Test case & E2E

Dựa trên mục tiêu/tiêu chí trong phase và phản hồi thực tế của member ở Bước 5:

- Viết unit test (Jest) cho service/controller phía server.
- Viết E2E / workflow test bằng **Playwright** (chuẩn chung cho cả Nexus và Fizzle, thay cho
  phần "Cypress/Playwright" ghi chưa rõ trong docs gốc) cho luồng chính phía client.

Chạy test, sửa tới khi pass, rồi **điền ngay vào mục "Kết quả Phase N" của phase đang làm trong
`plans/<ten-trang>.PLAN.md`** (cả hai bản, frontend lẫn backend): số test pass/fail, và đánh
giá riêng theo **3 tiêu chí chất lượng** chứ không chỉ pass/fail chung chung —
- UI/UX: có follow file Design System của repo không, component chính có dùng Angular Material
  (shared/ui wrap lại) không, icon có dùng mat-icon + Google Fonts không, có đủ trạng thái
  loading/empty/error không.
- Feature: đối chiếu với danh sách Feature của trang trong `reference/plan-*.md`, feature nào
  đã hoạt động đúng, feature nào chưa.
- Data: DTO/validate đã đủ chưa, response có lộ field nhạy cảm không, mã lỗi HTTP đúng ngữ
  cảnh chưa.

Đây chính là nơi lưu lại "phiên bản" và kết quả của từng lần triển khai — không chỉ tóm tắt
miệng trong chat rồi thôi, vì chat không đi vào lịch sử git còn PLAN.md thì có. Phần commit hash
và PR điền nốt ở Bước 7-8 sau khi có.

## Bước 7 — Git: tạo nhánh (chỉ lần đầu), commit, push, tạo Pull Request

Gọi `<nhanh-trang>` = `pages/<ten-trang>/<ten-member>` đã xác định ở Bước 0. Thực hiện cho
**từng repo có thay đổi** (client, server, hoặc cả hai). Trình tự khác nhau tuỳ đây là phase
đầu tiên của trang này hay không:

### Nếu đây là phase đầu tiên (nhánh `<nhanh-trang>` chưa tồn tại — first-time, xem Bước 0)
1. Đảm bảo có đủ thay đổi cần commit trong working tree (PLAN.md + code của phase 1).
2. Kiểm tra nhánh `<nhanh-trang>` thật sự chưa tồn tại: `git branch --list <nhanh-trang>` và
   `git ls-remote --heads origin <nhanh-trang>` — cả hai đều rỗng mới được tạo mới. Nếu một
   trong hai đã có (vd agent chạy lại Bước 7 sau khi bị gián đoạn) — coi như KHÔNG first-time
   nữa, chuyển sang nhánh có sẵn (`git checkout <nhanh-trang>`) và làm theo nhánh "phase sau".
3. **Tạo nhánh đúng 1 lần duy nhất cho trang này**: `git checkout -b <nhanh-trang>` (working
   tree hiện tại — kể cả thay đổi chưa commit — tự động đi theo nhánh mới, không mất gì).
4. `git status` — kiểm tra kỹ trước khi add: không được dính `.env`, key/secret, `node_modules`,
   file build. Nếu thấy gì khả nghi, mở file kiểm tra nội dung trước khi quyết định add.
5. `git add .`
6. `git commit -m "<Ten trang> - Phase 1: <mô tả ngắn>"`
7. `git push -u origin <nhanh-trang>` (lần đầu push nhánh mới nên cần `-u` để thiết lập tracking).
8. `gh pr create --base main --head <nhanh-trang> --title "<Ten trang>" --body "<tóm tắt scope trang + link tới plans/<ten-trang>.PLAN.md>"`.

### Nếu nhánh `<nhanh-trang>` đã tồn tại (phase 2 trở đi — KHÔNG tạo nhánh mới nữa)
1. `git branch --show-current` — xác nhận **khớp chính xác** `<nhanh-trang>`. Nếu sai nhánh (vd
   lỡ đang ở `main`), `git checkout <nhanh-trang>` trước — **tuyệt đối không tạo nhánh mới**,
   không tạo `<nhanh-trang>-2` hay biến thể nào khác.
2. `git status` — kiểm tra kỹ trước khi add (như trên).
3. `git add .`
4. `git commit -m "<Ten trang> - Phase N: <mô tả ngắn>"`
5. `git push` (không cần `-u`, nhánh đã tracking từ phase 1).
6. `git branch -vv` — xác nhận lại đang track đúng `origin/<nhanh-trang>`.
7. `gh pr list --head <nhanh-trang>` — PR đã có từ phase 1, **không tạo PR mới**, push thêm
   commit là đủ để GitHub tự cập nhật PR đang mở.

Vì mỗi trang có đúng 1 nhánh/1 PR xuyên suốt toàn bộ vòng đời (không phải tạo nhánh mới cho
từng phase), lịch sử commit trên nhánh đó chính là lịch sử phát triển đầy đủ của trang.

### Quy tắc an toàn khi git — không thương lượng
- Không bao giờ code trước khi thấy chữ `APPROVED` trong `PLAN.md` (Bước 2).
- Không bao giờ sửa code trang của member khác trên nhánh của mình — chỉ commit code thuộc
  đúng trang của nhánh `<nhanh-trang>`, để tránh conflict khi merge (xem Bước 3 mục a).
- Không bao giờ tạo nhánh mới nếu `<nhanh-trang>` đã tồn tại — luôn `git checkout` vào nhánh có
  sẵn rồi commit tiếp lên đó.
- Không bao giờ force-push (`--force`/`-f`), không bao giờ push thẳng vào `main`/`develop`.
- Không bao giờ tạo PR trùng cho cùng một nhánh.
- Không commit file `.env`, key, credential, hoặc bất kỳ thứ gì nhìn giống secret dù tên file
  có vẻ vô hại — mở ra đọc nội dung trước khi add nếu còn nghi ngờ.

## Bước 8 — Cập nhật PLAN.md & lặp lại

Sau khi push + PR xong, quay lại điền nốt phần còn thiếu trong mục "Kết quả Phase N" (commit
hash vừa push, link PR), sửa `Status:` của phase đó thành `DONE`, và điền dòng tương ứng vào
bảng tóm tắt "Nhật ký duyệt & hoàn thành" ở cuối file — làm việc này **ở cả hai repo**, rồi
commit riêng lẻ thay đổi này vào từng repo (có thể gộp chung với commit code của phase nếu chưa
push, hoặc thêm 1 commit nhỏ "update PLAN.md" nếu đã push code trước đó) — không để 1 bên có
`DONE` với đầy đủ kết quả còn bên kia vẫn `APPROVED` hoặc thiếu kết quả. Hỏi member có muốn làm
phase tiếp theo không — nếu có, quay lại Bước 2 cho phase kế tiếp (vẫn cần `APPROVED` mới bằng
văn bản cho phase mới, không tính gộp từ lần duyệt trước; nhánh git thì giữ nguyên, không tạo
nhánh mới — xem Bước 7). Nếu member nói đã hết phase, đây là trang đã "triển khai full" — chuyển
sang Bước 9.

## Bước 9 — Tổng kết trang & bàn giao cho mentor (chỉ làm khi ĐÃ xong tất cả phase của trang)

Đây là bước "triển khai full" — đánh giá cả trang như một sản phẩm hoàn chỉnh, không chỉ từng
phase riêng lẻ, trước khi để mentor Luke duyệt PR.

1. **Hồi quy toàn bộ**: chạy lại toàn bộ test (unit + E2E Playwright) của **tất cả** các phase
   trong trang, không chỉ phase cuối — phase sau rất dễ vô tình làm hỏng phase trước khi member
   còn mới học, phải bắt lỗi này trước khi bàn giao.
2. **Điền mục "Tổng kết trang"** ở cuối `plans/<ten-trang>.PLAN.md` (cả hai bản): đánh giá tổng
   thể theo đúng 3 tiêu chí UI/UX — Feature — Data cho toàn bộ trang (không phải từng phase),
   liệt kê rõ còn thiếu gì nếu có (được phép bàn giao dù chưa hoàn hảo 100%, miễn ghi rõ phần
   nào chưa đạt để mentor biết).
3. Cập nhật lại mô tả PR bằng `gh pr edit <nhanh-trang> --body "<bản tổng kết 3 tiêu chí>"` để
   mentor review đúng theo khung 3 tiêu chí này thay vì phải tự suy luận.
4. Báo cho member: trang đã hoàn thành, PR đã sẵn sàng, mentor sẽ xem và accept.

## File tham khảo trong skill này

- `reference/plan-nexus.md`, `reference/plan-fizzle.md` — bảng Members, trang được giao, mô tả
  feature/core stack từng trang, dùng để tra cứu ở Bước 0 và lập plan sát scope ở Bước 2.
- `reference/folder-structure-nexus-client.md`, `reference/folder-structure-nexus-server.md`,
  `reference/folder-structure-fizzle-client.md`, `reference/folder-structure-fizzle-server.md`
  — cây thư mục + bảng ownership riêng cho từng project (Nexus dựng từ `plan_246`, Fizzle từ
  `plan_357`), dùng ở Bước 3.
- `templates/PLAN_TEMPLATE.md` — mẫu file kế hoạch phase dùng ở Bước 2.
