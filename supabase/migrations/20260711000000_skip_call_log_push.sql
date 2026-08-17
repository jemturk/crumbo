-- The on_message_inserted trigger fires send_push_notification() on EVERY messages insert.
-- Call teardown writes [CALL_LOG:*] history rows into messages, which produced garbage
-- chat-style pushes like: "Aycan sent a cookie!" / "[CALL_LOG:ENDED_AUDIO]".
-- Skip those rows — they are call history, not chat, and the call UX has its own signaling.

create or replace function public.send_push_notification()
returns trigger
language plpgsql
security definer
as $function$
declare
  receiver_token text;
  sender_name text;
begin
  -- Call-log rows are chat-history artifacts of the calling feature; never push them.
  if new.text like '[CALL_LOG:%' then
    return new;
  end if;

  -- Get the receiver's push token
  select push_token into receiver_token
  from profiles
  where cookie_code = new.receiver_code;

  -- Get the sender's name
  select name into sender_name
  from profiles
  where cookie_code = new.sender_code;

  if sender_name is null then
    sender_name := 'Someone';
  end if;

  if receiver_token is not null and receiver_token != '' then
    perform extensions.http_post(
      'https://exp.host/--/api/v2/push/send',
      json_build_object(
        'to', receiver_token,
        'title', sender_name || ' sent a cookie!',
        'body', new.text,
        'sound', 'default'
      )::text,
      'application/json'
    );
  end if;

  return new;
end;
$function$;
