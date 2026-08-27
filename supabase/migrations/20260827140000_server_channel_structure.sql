-- Canonical shared category/channel hierarchy for every server member.
-- Category collapse remains a client preference; the structure itself belongs to the server.

alter table public.servers
    add column if not exists channel_structure jsonb,
    add column if not exists channel_structure_revision bigint not null default 0,
    add column if not exists channel_structure_updated_at timestamptz,
    add column if not exists channel_structure_updated_by uuid;

alter table public.servers
    drop constraint if exists servers_channel_structure_object_check;

alter table public.servers
    add constraint servers_channel_structure_object_check
    check (channel_structure is null or jsonb_typeof(channel_structure) = 'object');

comment on column public.servers.channel_structure is
    'Canonical shared two-level category/channel layout. Null means derive the default layout from channels.position.';

comment on column public.servers.channel_structure_revision is
    'Monotonic revision incremented whenever an authorized manager updates channel_structure.';

