-- ============================================================================
-- DM, tin nhắn, đính kèm, read state
--
-- Nguồn: docs/nexus_schema.sql mục 6, 7, 8, 9.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- DIRECT MESSAGES (nằm ngoài server)
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
    id          uuid primary key default gen_random_uuid(),
    type        conversation_type not null default 'dm',
    name        text,                                    -- chỉ dùng cho group
    icon_url    text,
    owner_id    uuid references public.profiles(id) on delete set null,
    -- dm_key = uuid nhỏ hơn || ':' || uuid lớn hơn, do NestJS sinh khi type='dm'.
    -- Chặn tạo trùng phòng DM giữa cùng hai người.
    dm_key      text,
    created_at  timestamptz not null default now()
);

create unique index if not exists idx_conversations_dm_key
    on public.conversations (dm_key) where dm_key is not null;

create table if not exists public.conversation_participants (
    conversation_id uuid not null references public.conversations(id) on delete cascade,
    user_id         uuid not null references public.profiles(id) on delete cascade,
    joined_at       timestamptz not null default now(),

    primary key (conversation_id, user_id)
);

create index if not exists idx_conv_participants_user
    on public.conversation_participants (user_id);

-- ---------------------------------------------------------------------------
-- MESSAGES
--
-- Ba yêu cầu bắt buộc quyết định thiết kế bảng này:
--   (a) Cursor pagination -> id bigint sortable + index (channel_id, id desc)
--   (b) Optimistic UI     -> client_nonce dedupe khi client gửi trước, ack sau
--   (c) Soft delete       -> deleted_at, giữ dòng để hiện "Tin nhắn đã bị xoá"
--
-- Tin nhắn thuộc ĐÚNG MỘT trong hai: channel (server) hoặc conversation (DM).
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
    id              bigint generated always as identity primary key,

    channel_id      uuid references public.channels(id) on delete cascade,
    conversation_id uuid references public.conversations(id) on delete cascade,

    author_id       uuid references public.profiles(id) on delete set null,
    type            message_type not null default 'default',
    content         text,

    reply_to_id     bigint references public.messages(id) on delete set null,

    -- Sticker gọi từ API ngoài (Giphy/Tenor): KHÔNG tải ảnh về Storage, chỉ lưu
    -- tham chiếu + attribution.
    sticker_provider text,
    sticker_id       text,
    sticker_url      text,

    -- Idempotency key do client sinh (uuid v4) trước khi gửi.
    client_nonce    uuid,

    edited_at       timestamptz,
    deleted_at      timestamptz,
    created_at      timestamptz not null default now(),

    constraint message_single_target check (
        (channel_id is not null and conversation_id is null) or
        (channel_id is null and conversation_id is not null)
    ),
    -- Tin rỗng chỉ hợp lệ khi có attachment hoặc sticker. Ràng buộc DB không nhìn
    -- được sang bảng attachments, nên service layer phải tự kiểm tra thêm.
    constraint content_len check (content is null or char_length(content) <= 4000)
);

-- Index chủ lực cho cursor pagination:
--   SELECT * FROM messages WHERE channel_id = $1 AND id < $cursor
--   ORDER BY id DESC LIMIT 50;
-- TUYỆT ĐỐI không dùng OFFSET.
create index if not exists idx_messages_channel_cursor
    on public.messages (channel_id, id desc) where channel_id is not null;

create index if not exists idx_messages_conversation_cursor
    on public.messages (conversation_id, id desc) where conversation_id is not null;

-- Chặn ghi trùng khi client retry.
create unique index if not exists idx_messages_nonce
    on public.messages (author_id, client_nonce) where client_nonce is not null;

create index if not exists idx_messages_reply
    on public.messages (reply_to_id) where reply_to_id is not null;

-- ---------------------------------------------------------------------------
-- ATTACHMENTS
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
    id            uuid primary key default gen_random_uuid(),
    message_id    bigint not null references public.messages(id) on delete cascade,
    storage_path  text not null,                       -- path trong Supabase Storage
    filename      text not null,
    mime_type     text not null,
    size_bytes    bigint not null,
    width         integer,                             -- chỉ có với ảnh/video
    height        integer,
    created_at    timestamptz not null default now(),

    constraint size_positive check (size_bytes > 0)
);

create index if not exists idx_attachments_message on public.attachments (message_id);

-- ---------------------------------------------------------------------------
-- READ STATE — nguồn DUY NHẤT cho badge unread
--
-- Badge "3 tin chưa đọc" phải tính từ bảng này, không đếm trong memory: user F5
-- hoặc mở tab thứ hai là sai ngay.
--   unread = SELECT count(*) FROM messages
--            WHERE channel_id = $1 AND id > last_read_message_id;
--
-- Bảng không có primary key, chỉ hai partial unique index — khi upsert phải chỉ
-- rõ conflict target (user_id, channel_id), không dùng mặc định được.
-- ---------------------------------------------------------------------------
create table if not exists public.read_states (
    user_id              uuid not null references public.profiles(id) on delete cascade,
    channel_id           uuid references public.channels(id) on delete cascade,
    conversation_id      uuid references public.conversations(id) on delete cascade,
    last_read_message_id bigint,
    mention_count        integer not null default 0,
    updated_at           timestamptz not null default now(),

    constraint read_state_single_target check (
        (channel_id is not null and conversation_id is null) or
        (channel_id is null and conversation_id is not null)
    )
);

create unique index if not exists idx_read_states_channel
    on public.read_states (user_id, channel_id) where channel_id is not null;

create unique index if not exists idx_read_states_conversation
    on public.read_states (user_id, conversation_id) where conversation_id is not null;
