-- send_push_notification() (see 20260804000000_fix_message_push_notifications.sql) read
-- profiles.name for the SENDER's display name in every push title. That's correct for a kid row
-- (profiles.name IS the kid's real name), but a parent/adult row's profiles.name is never a real
-- name at all -- it's always PARENT_ROW_NAME_MARKER, a fixed constant every parent row is
-- deliberately set to (see storage.ts's own comment on that constant; kid rows are the only ones
-- that store a real name in that column). A parent's actual display name instead lives inside
-- the same JSON blob in profiles.push_token already unwrapped for the receiver's token in the
-- previous migration, at payload.parentName (see StorageService.buildParentPushTokenPayload) --
-- confirmed live: a parent-to-parent "Hi" push showed that marker's hex string as the sender
-- name. Falls back to the email portion of their PARENT:<email> cookie_code if parentName was
-- never set, mirroring the client's own parentDisplayName computation.

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
        'sound', 'default'
      )::text,
      'application/json'
    );
  end if;

  return new;
end;
$function$;
