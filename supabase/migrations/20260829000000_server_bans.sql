-- Migration: Create server_bans table and RLS policies
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_bans (
    server_id UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NULL,
    banned_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

-- Index cho tra cứu nhanh theo server_id
CREATE INDEX IF NOT EXISTS idx_server_bans_server_id ON public.server_bans(server_id);

-- Phân quyền RLS & Grant cho service_role
ALTER TABLE public.server_bans ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.server_bans TO service_role;
