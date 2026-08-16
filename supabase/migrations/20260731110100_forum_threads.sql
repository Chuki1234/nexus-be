-- ============================================================================
-- Kênh forum: bài đăng (thread), nhãn trạng thái, và reaction
--
-- Mở rộng scope so với NEXUS_CONTEXT bản 31/07 — chốt ngày 31/07 để dựng được
-- màn hình forum trong tài liệu phân tích UI Discord.
--
-- Mô hình: kênh `type='forum'` chứa nhiều `threads`; mỗi thread chứa nhiều
-- `messages`. Bài đăng KHÔNG phải là một message đặc biệt — tách bảng riêng vì
-- nó có tiêu đề, nhãn, trạng thái ghim/khoá mà message không có.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- THREADS — một bài đăng trong kênh forum
-- ---------------------------------------------------------------------------
create table if not exists public.threads (
    id          uuid primary key default gen_random_uuid(),
    channel_id  uuid not null references public.channels(id) on delete cascade,
    title       text not null,
    author_id   uuid references public.profiles(id) on delete set null,
    is_pinned   boolean not null default false,
    is_locked   boolean not null default false,
    -- Đánh dấu thời điểm có tin cuối, để sắp xếp "hoạt động gần nhất" mà không
    -- phải quét toàn bộ bảng messages.
    last_message_at timestamptz not null default now(),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint thread_title_len check (char_length(title) between 1 and 100)
);

create index if not exists idx_threads_channel_activity
    on public.threads (channel_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- MESSAGES — thêm đích thứ ba
--
-- Trước đây tin nhắn thuộc đúng một trong hai: channel hoặc conversation. Giờ
-- có thêm thread, nên phải viết lại ràng buộc thay vì thêm chồng lên.
-- ---------------------------------------------------------------------------
alter table public.messages
    add column if not exists thread_id uuid references public.threads(id) on delete cascade;

alter table public.messages drop constraint if exists message_single_target;

alter table public.messages
    add constraint message_single_target check (
        (channel_id is not null)::int
      + (conversation_id is not null)::int
      + (thread_id is not null)::int = 1
    );

-- Cùng kiểu index cursor pagination như hai đích kia — cấm OFFSET vẫn áp dụng.
create index if not exists idx_messages_thread_cursor
    on public.messages (thread_id, id desc) where thread_id is not null;

-- ---------------------------------------------------------------------------
-- NHÃN TRẠNG THÁI BÀI ĐĂNG ("Mới", "Đang cân nhắc", "Đã thực hiện")
--
-- Nhãn định nghĩa theo từng kênh forum, không phải danh sách cứng toàn hệ thống.
-- ---------------------------------------------------------------------------
create table if not exists public.forum_tags (
    id          uuid primary key default gen_random_uuid(),
    channel_id  uuid not null references public.channels(id) on delete cascade,
    name        text not null,
    emoji       text,
    position    integer not null default 0,

    constraint forum_tag_name_len check (char_length(name) between 1 and 32)
);

create unique index if not exists idx_forum_tags_unique_name
    on public.forum_tags (channel_id, lower(name));

create table if not exists public.thread_tags (
    thread_id uuid not null references public.threads(id) on delete cascade,
    tag_id    uuid not null references public.forum_tags(id) on delete cascade,

    primary key (thread_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- REACTION — dùng cho cả tin nhắn thường lẫn bài đăng forum
--
-- Một người chỉ thả được một lần cho mỗi emoji trên mỗi tin; khoá chính lo việc đó.
-- ---------------------------------------------------------------------------
create table if not exists public.message_reactions (
    message_id bigint not null references public.messages(id) on delete cascade,
    user_id    uuid   not null references public.profiles(id) on delete cascade,
    emoji      text   not null,
    created_at timestamptz not null default now(),

    primary key (message_id, user_id, emoji),
    constraint reaction_emoji_len check (char_length(emoji) between 1 and 32)
);

-- Truy vấn nóng: đếm reaction theo emoji cho một tin.
create index if not exists idx_message_reactions_message
    on public.message_reactions (message_id, emoji);

-- ---------------------------------------------------------------------------
-- READ STATE cho thread
-- ---------------------------------------------------------------------------
alter table public.read_states
    add column if not exists thread_id uuid references public.threads(id) on delete cascade;

alter table public.read_states drop constraint if exists read_state_single_target;

alter table public.read_states
    add constraint read_state_single_target check (
        (channel_id is not null)::int
      + (conversation_id is not null)::int
      + (thread_id is not null)::int = 1
    );

create unique index if not exists idx_read_states_thread
    on public.read_states (user_id, thread_id) where thread_id is not null;

-- ---------------------------------------------------------------------------
-- Trigger + RLS, giống mọi bảng khác
-- ---------------------------------------------------------------------------
drop trigger if exists trg_threads_updated on public.threads;
create trigger trg_threads_updated
    before update on public.threads
    for each row execute function public.set_updated_at();

do $$
declare
    t text;
begin
    foreach t in array array['threads', 'forum_tags', 'thread_tags', 'message_reactions'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from anon, authenticated', t);
    end loop;
end
$$;
