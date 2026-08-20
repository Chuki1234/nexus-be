-- ============================================================================
-- Trigger updated_at + bật RLS deny-all trên toàn bộ bảng
--
-- Nguồn: docs/nexus_schema.sql mục 12, 13.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Trigger updated_at cho các bảng vừa tạo
-- (profiles đã gắn ở migration reconcile_profiles)
-- ---------------------------------------------------------------------------
drop trigger if exists trg_servers_updated on public.servers;
create trigger trg_servers_updated
    before update on public.servers
    for each row execute function public.set_updated_at();

drop trigger if exists trg_channels_updated on public.channels;
create trigger trg_channels_updated
    before update on public.channels
    for each row execute function public.set_updated_at();

drop trigger if exists trg_friendships_updated on public.friendships;
create trigger trg_friendships_updated
    before update on public.friendships
    for each row execute function public.set_updated_at();

drop trigger if exists trg_settings_updated on public.user_settings;
create trigger trg_settings_updated
    before update on public.user_settings
    for each row execute function public.set_updated_at();

-- read_states có updated_at nhưng luôn được ghi tường minh khi đánh dấu đã đọc,
-- nên không gắn trigger — tránh ghi đè giá trị mà service cố tình đặt.

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY — deny all
--
-- Bật RLS nhưng KHÔNG tạo policy nào:
--   * service_role (NestJS)          -> bypass RLS, truy cập bình thường
--   * anon / authenticated (Angular) -> không đọc/ghi được gì
--
-- Đây không phải lớp phân quyền (phân quyền nằm ở NestJS Guards) mà là chốt chặn
-- phòng khi khoá công khai bị lộ trong bundle frontend. Đừng "sửa" bằng cách thêm
-- policy — nếu gặp lỗi permission thì nguyên nhân là đang query bằng anon key.
--
-- revoke thêm một lớp nữa: RLS lọc hàng, còn GRANT mới là quyền chạm vào bảng.
-- ---------------------------------------------------------------------------
do $$
declare
    t text;
    tables text[] := array[
        'servers', 'server_members', 'roles', 'member_roles',
        'channels', 'channel_overwrites',
        'conversations', 'conversation_participants',
        'messages', 'attachments', 'read_states',
        'friendships', 'invites', 'user_settings', 'notifications'
    ];
begin
    foreach t in array tables loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from anon, authenticated', t);
    end loop;
end
$$;

-- profiles đã bật RLS + revoke ở migration profiles_deny_all_rls (29/07).
