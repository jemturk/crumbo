-- Supabase advisor: "Function Search Path Mutable" — send_push_notification() (the AFTER INSERT
-- trigger on messages that sends the Expo push, see 20260805000001_add_chat_message_push_routing.sql)
-- is SECURITY DEFINER but never pinned its search_path, unlike every RPC added in the RLS
-- lockdown work. Same hardening as those: without a fixed search_path, a SECURITY DEFINER
-- function resolves unqualified names using the CALLER's session search_path rather than a fixed
-- one, which is the standard privilege-escalation vector for this class of function (a
-- caller-controlled schema searched before `public` could shadow a real table/function with a
-- malicious one, executed with this function's elevated rights). Pinning it removes that risk.
create or replace function public.send_push_notification()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  receiver_token text;
  sender_name text;
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

  select name into sender_name
  from profiles
  where cookie_code = new.sender_code;

  if sender_name is null then
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
