-- Backgrounded/killed recipients were getting NO push for new messages/photos/drawings/voice
-- notes. Two bugs, both fixed here:
--
-- 1. The on_message_inserted trigger that's supposed to fire send_push_notification() on every
--    messages insert was never captured in a migration anywhere in this repo -- only the
--    function body was (see 20260711000000_skip_call_log_push.sql). It must have been created
--    by hand at some point. If this database was ever rebuilt from migrations alone (a reset,
--    a new environment, a staging/prod re-provision), the function would exist but nothing
--    would be attached to messages, silently disabling ALL message-insert push notifications
--    while chat itself kept working fine via realtime. (Re)creating it here, idempotently,
--    finally makes it part of version control instead of living only in whatever DB it was
--    first typed into.
--
-- 2. send_push_notification() sent profiles.push_token to Expo's push API as-is. That's correct
--    for a kid row (StorageService.registerPushToken upserts the raw token directly), but a
--    parent/relative row's push_token column instead holds their whole kids/friends sync
--    payload as JSON (buildParentPushTokenPayload), with the real token nested at
--    payload.pushToken (StorageService.registerParentPushToken) -- see storage.ts's own comment
--    pointing at notify-call/index.ts's matching unwrap logic, which this function never had.
--    So any message addressed to a parent/adult silently failed to push. Fixed to unwrap both
--    shapes, mirroring notify-call/index.ts exactly.
--
-- Also swapped the raw [IMAGE:<url>]/[DRAWING:<url>]/[VOICE:<seconds>|<url>] tag text for the
-- same friendly labels the in-app chat list preview already uses (formatMessagePreview in
-- src/components/ChatMediaBubble.tsx), so a photo/drawing/voice push reads "📷 Photo" instead of
-- a raw URL string.

-- Safe no-op if already installed (possibly under a different creation path/schema check) --
-- captures the dependency http_post relies on, which was likewise never in version control.
create extension if not exists http with schema extensions;

create or replace function public.send_push_notification()
returns trigger
language plpgsql
security definer
as $function$
declare
  receiver_token text;
  sender_name text;
  expo_token text;
  payload jsonb;
  body_text text;
begin
  -- Call-log rows are chat-history artifacts of the calling feature; never push them.
  if new.text like '[CALL_LOG:%' then
    return new;
  end if;

  select push_token into receiver_token
  from profiles
  where cookie_code = new.receiver_code;

  select name into sender_name
  from profiles
  where cookie_code = new.sender_code;

  if sender_name is null then
    sender_name := 'Someone';
  end if;

  -- Resolve the actual Expo push token, trying both storage shapes (see header comment).
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
      -- Not JSON either -- genuinely not a token, leave expo_token null.
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

drop trigger if exists on_message_inserted on public.messages;
create trigger on_message_inserted
  after insert on public.messages
  for each row execute function public.send_push_notification();
