-- Tapping a chat-message push always landed on whatever screen the app last had open, instead
-- of the sender's conversation. send_push_notification() only ever sent `to`/`title`/`body`/
-- `sound` -- no `data` payload at all -- so callkeep.ts's notification-tap listener (which
-- already knows how to route a missed-call or call-signal tap to the right chat, see its
-- `data?.kind === 'missed_call'` branch) had nothing to route a plain message tap on; the OS
-- just fell back to its default "launch the app" behavior with no navigation.
--
-- Adds a `data` object identifying the conversation (kind + both cookie codes), and the
-- matching client-side tap handler now routes on it the same way it already does for
-- missed-call taps.

create or replace function public.send_push_notification()
returns trigger
language plpgsql
security definer
as $function$
declare
  receiver_token text;
  sender_push_token text;
  sender_name text;
  expo_token text;
  receiver_payload jsonb;
  sender_payload jsonb;
  body_text text;
begin
  -- Call-log rows are chat-history artifacts of the calling feature; never push them.
  if new.text like '[CALL_LOG:%' then
    return new;
  end if;

  select push_token into receiver_token
  from profiles
  where cookie_code = new.receiver_code;

  if new.sender_code like 'PARENT:%' then
    select push_token into sender_push_token
    from profiles
    where cookie_code = new.sender_code;

    sender_name := null;
    if sender_push_token is not null and sender_push_token != '' then
      begin
        sender_payload := sender_push_token::jsonb;
        if sender_payload ? 'parentName'
          and sender_payload->>'parentName' is not null
          and sender_payload->>'parentName' != ''
        then
          sender_name := sender_payload->>'parentName';
        end if;
      exception when others then
        sender_name := null;
      end;
    end if;
    if sender_name is null then
      -- 'PARENT:' is 7 chars -- substring from position 8 is everything after it (the email).
      sender_name := substring(new.sender_code from 8);
    end if;
  else
    select name into sender_name
    from profiles
    where cookie_code = new.sender_code;
  end if;

  if sender_name is null or sender_name = '' then
    sender_name := 'Someone';
  end if;

  -- Resolve the actual Expo push token, trying both storage shapes (see prior migration).
  expo_token := null;
  if receiver_token is not null and (receiver_token like 'ExponentPushToken%' or receiver_token like 'ExpoPushToken%') then
    expo_token := receiver_token;
  elsif receiver_token is not null and receiver_token != '' then
    begin
      receiver_payload := receiver_token::jsonb;
      if receiver_payload ? 'pushToken'
        and (receiver_payload->>'pushToken' like 'ExponentPushToken%' or receiver_payload->>'pushToken' like 'ExpoPushToken%')
      then
        expo_token := receiver_payload->>'pushToken';
      end if;
    exception when others then
      expo_token := null;
    end;
  end if;

  if expo_token is not null then
    if new.text like '[IMAGE:%' then
      body_text := '📷 Photo';
    elsif new.text like '[DRAWING:%' then
      body_text := '🎨 Drawing';
    elsif new.text like '[VOICE:%' then
      body_text := '🎤 Voice Message';
    else
      body_text := new.text;
    end if;

    perform extensions.http_post(
      'https://exp.host/--/api/v2/push/send',
      json_build_object(
        'to', expo_token,
        'title', sender_name || ' sent a cookie!',
        'body', body_text,
        'sound', 'default',
        'data', json_build_object(
          'kind', 'chat_message',
          'senderCode', new.sender_code,
          'receiverCode', new.receiver_code
        )
      )::text,
      'application/json'
    );
  end if;

  return new;
end;
$function$;
