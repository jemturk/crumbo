-- Real bug (pre-existing, not introduced by this session's work): send_push_notification()
-- resolves the notification's sender name from profiles.name, but a PARENT row's name column is
-- never a real name — it's PARENT_ROW_NAME_MARKER, a fixed placeholder string (the literal
-- SHA-256 initial hash constants concatenated, see storage.ts), since a parent's actual display
-- name lives inside push_token's JSON blob (`parentName`), not the name column. Every message a
-- parent sends was therefore pushed to the kid's device with that marker string as the sender —
-- confirmed directly: a real user saw "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c..." as
-- the notification title on their kid's phone. Kid-sent messages were unaffected since a kid
-- row's name column genuinely does hold their real name.
create or replace function public.send_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  receiver_token text;
  sender_name text;
  sender_row_name text;
  sender_push_token text;
  expo_token text;
  payload jsonb;
  body_text text;
begin
  if new.text like '[CALL_LOG:%' then
    return new;
  end if;

  select push_token into receiver_token
  from profiles
  where cookie_code = new.receiver_code;

  select name, push_token into sender_row_name, sender_push_token
  from profiles
  where cookie_code = new.sender_code;

  if new.sender_code like 'PARENT:%' then
    begin
      sender_name := (sender_push_token::jsonb ->> 'parentName');
    exception when others then
      sender_name := null;
    end;
    if sender_name is null or sender_name = '' then
      -- Falls back to the email portion of the cookie code rather than the raw marker string —
      -- still not a display name, but at least not meaningless-looking to a kid.
      sender_name := split_part(new.sender_code, ':', 2);
    end if;
  else
    sender_name := sender_row_name;
  end if;

  if sender_name is null or sender_name = '' then
    sender_name := 'Someone';
  end if;

  expo_token := null;
  if receiver_token is not null and (receiver_token like 'ExponentPushToken%' or receiver_token like 'ExpoPushToken%') then
    expo_token := receiver_token;
  elsif receiver_token is not null and receiver_token != '' then
    begin
      payload := receiver_token::jsonb;
      if payload ? 'pushToken'
        and (payload->>'pushToken' like 'ExponentPushToken%' or payload->>'pushToken' like 'ExpoPushToken%')
      then
        expo_token := payload->>'pushToken';
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
        'sound', 'default'
      )::text,
      'application/json'
    );
  end if;

  return new;
end;
$function$;
