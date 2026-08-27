-- Gỡ giới hạn ứng dụng 4.000 ký tự khỏi nội dung tin nhắn.
-- PostgreSQL `text` vẫn là kiểu lưu trữ canonical; giới hạn kích thước request
-- hạ tầng được giữ riêng và không còn được biểu diễn thành giới hạn ký tự chat.

alter table public.messages
  drop constraint if exists content_len;

do $migration$
declare
  v_signature text;
  v_proc regprocedure;
  v_definition text;
  v_patched text;
  v_primary_signatures constant text[] := array[
    'public.create_channel_message(uuid,uuid,text,uuid,bigint,jsonb,boolean,jsonb)',
    'public.create_conversation_message(uuid,uuid,text,uuid,bigint,jsonb,boolean,jsonb)'
  ];
begin
  foreach v_signature in array v_primary_signatures loop
    v_proc := to_regprocedure(v_signature);
    if v_proc is null then
      raise exception 'Không tìm thấy RPC bắt buộc %', v_signature;
    end if;

    select pg_get_functiondef(v_proc) into v_definition;
    v_patched := regexp_replace(
      v_definition,
      $regex$[[:space:]]*if v_trimmed_content is not null and char_length\(v_trimmed_content\) > 4000 then[[:space:]]*raise exception 'Nội dung tin nhắn không được vượt quá 4000 ký tự' using errcode = '22023';[[:space:]]*end if;$regex$,
      E'\n',
      'i'
    );

    if v_patched = v_definition then
      raise exception 'Không tìm thấy guard 4.000 ký tự trong RPC %', v_signature;
    end if;

    execute v_patched;
  end loop;
end
$migration$;

-- RPC legacy này không còn nằm trên đường gửi chính, nhưng vẫn gỡ guard nếu nó
-- tồn tại để mọi đường chuyển tiếp cũ có cùng hợp đồng không giới hạn ký tự.
do $migration$
declare
  v_proc regprocedure := to_regprocedure(
    'public.create_forwarded_message(uuid,uuid,text,uuid,jsonb)'
  );
  v_definition text;
  v_patched text;
begin
  if v_proc is null then
    return;
  end if;

  select pg_get_functiondef(v_proc) into v_definition;
  v_patched := regexp_replace(
    v_definition,
    $regex$[[:space:]]*if p_content is not null and pg_catalog\.char_length\(p_content\) > 4000 then[[:space:]]*raise exception 'Nội dung tin nhắn vượt quá 4000 ký tự cho phép\.'[[:space:]]*using errcode = '22023';[[:space:]]*end if;$regex$,
    E'\n',
    'i'
  );

  if v_patched <> v_definition then
    execute v_patched;
  end if;
end
$migration$;

comment on column public.messages.content is
  'Nội dung văn bản của tin nhắn; không áp đặt giới hạn ký tự ở tầng ứng dụng.';
