-- Restore Stipop sticker support after the user-blocking migration redefined
-- create_conversation_message with the older GIPHY-only validation guard.
do $migration$
declare
    v_signature regprocedure :=
        'public.create_conversation_message(uuid,uuid,text,uuid,bigint,jsonb,boolean,jsonb)'::regprocedure;
    v_definition text;
    v_old_guard constant text :=
        'if v_ext_provider <> ''giphy'' or v_ext_media_type <> ''gif'' or v_ext_external_id is null';
    v_new_guard constant text :=
        'if not ((v_ext_provider = ''giphy'' and v_ext_media_type = ''gif'') or (v_ext_provider = ''stipop'' and v_ext_media_type = ''sticker'')) or v_ext_external_id is null';
begin
    v_definition := pg_get_functiondef(v_signature::oid);

    if position(v_new_guard in v_definition) = 0 then
        if position(v_old_guard in v_definition) = 0 then
            raise exception 'Không tìm thấy external_media guard cần cập nhật trong RPC %',
                v_signature::text;
        end if;

        v_definition := replace(v_definition, v_old_guard, v_new_guard);
        execute v_definition;
    end if;
end
$migration$;

do $assertion$
begin
    if position(
        'v_ext_provider = ''stipop'' and v_ext_media_type = ''sticker'''
        in pg_get_functiondef(
            'public.create_conversation_message(uuid,uuid,text,uuid,bigint,jsonb,boolean,jsonb)'::regprocedure::oid
        )
    ) = 0 then
        raise exception 'RPC create_conversation_message chưa cho phép Stipop sticker';
    end if;
end
$assertion$;
