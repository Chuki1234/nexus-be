-- ============================================================================
-- Extension + enum dùng chung
--
-- Nguồn: docs/nexus_schema.sql mục 0 và 1.
-- Tách riêng file vì mọi bảng phía sau đều phụ thuộc vào các kiểu này.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- so sánh không phân biệt hoa/thường

-- `create type` không có `if not exists`, nên bọc lại để chạy lại được migration.
do $$
begin
    -- Trạng thái LIVE nằm ở memory/LiveKit; cột trong DB chỉ lưu lựa chọn thủ công
    -- của user (ví dụ cố tình để "Không làm phiền").
    if not exists (select 1 from pg_type where typname = 'presence_status') then
        create type presence_status as enum ('online', 'idle', 'dnd', 'offline');
    end if;

    if not exists (select 1 from pg_type where typname = 'channel_type') then
        create type channel_type as enum ('text', 'voice');
    end if;

    -- 'dm' = 1-1, 'group' = nhóm chat không thuộc server nào.
    if not exists (select 1 from pg_type where typname = 'conversation_type') then
        create type conversation_type as enum ('dm', 'group');
    end if;

    if not exists (select 1 from pg_type where typname = 'friendship_status') then
        create type friendship_status as enum ('pending', 'accepted', 'blocked');
    end if;

    -- 'default' = tin người dùng; hai giá trị còn lại là tin hệ thống.
    if not exists (select 1 from pg_type where typname = 'message_type') then
        create type message_type as enum ('default', 'system_join', 'system_leave');
    end if;

    -- Đích của permission overwrite ở cấp channel.
    if not exists (select 1 from pg_type where typname = 'overwrite_target') then
        create type overwrite_target as enum ('role', 'member');
    end if;
end
$$;
