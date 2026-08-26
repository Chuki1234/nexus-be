-- ============================================================================
-- HOTFIX: Cho phép gửi Stipop Sticker trong create_channel_message & create_conversation_message
-- ============================================================================

-- 1. Cập nhật check constraint cho bảng message_external_media
alter table public.message_external_media
    drop constraint if exists message_external_media_provider_check;

alter table public.message_external_media
    add constraint message_external_media_provider_check
    check (provider in ('giphy', 'stipop'));

alter table public.message_external_media
    drop constraint if exists message_external_media_media_type_check;

alter table public.message_external_media
    add constraint message_external_media_media_type_check
    check (media_type in ('gif', 'sticker'));

-- 2. Tự động cập nhật điều kiện external_media validation trong RPCs
do $migration$
declare
    v_signature regprocedure;
    v_definition text;
    v_old_guard constant text :=
        'if v_ext_provider <> ''giphy'' or v_ext_media_type <> ''gif'' or v_ext_external_id is null';
    v_new_guard constant text :=
        'if not ((v_ext_provider = ''giphy'' and v_ext_media_type = ''gif'') or (v_ext_provider = ''stipop'' and v_ext_media_type = ''sticker'')) or v_ext_external_id is null';
begin
    foreach v_signature in array array[
        'public.create_channel_message(uuid,uuid,text,uuid,bigint,jsonb,boolean,jsonb)'::regprocedure,
        'public.create_conversation_message(uuid,uuid,text,uuid,bigint,jsonb,boolean,jsonb)'::regprocedure
    ]
    loop
        v_definition := pg_get_functiondef(v_signature::oid);

        if position(v_new_guard in v_definition) > 0 then
            continue;
        end if;

        if position(v_old_guard in v_definition) = 0 then
            raise exception 'Không tìm thấy external_media guard trong RPC %',
                v_signature::text;
        end if;

        v_definition := replace(v_definition, v_old_guard, v_new_guard);
        execute v_definition;
    end loop;
end
$migration$;
