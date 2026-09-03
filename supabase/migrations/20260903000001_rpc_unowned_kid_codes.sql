-- A parent row's kids[] is a DENORMALISED MIRROR of what profiles.owner_user_id actually says,
-- and buildParentPushTokenPayload rebuilds it from this device's local caches. Those caches are
-- not scoped per account, so a kid left in KIDS_LIST by a previous session could be written into
-- a DIFFERENT account's row on its first sync — which is exactly how a relative, given only a
-- chat contact for a kid, ended up mirroring that kid into their own kids[] and seeing them under
-- their own Managed Users (harmless server-side, since rpc_read_owned_parent_row resolves a kid's
-- real settings strictly via owner_user_id and never consults a relative's mirror — but it
-- presented as control the relative must never appear to have).
--
-- Answers the narrow question "which of these codes DEFINITELY belong to somebody else?" rather
-- than the broader "which do I own?" on purpose. The caller drops only what this positively
-- disowns, so a kid whose row is missing or whose owner_user_id is null is always KEPT. Getting
-- that backwards is the disaster class buildParentPushTokenPayload's serverReadSucceeded guard
-- already exists to prevent: writing back fewer kids than a parent really has.
create or replace function public.rpc_unowned_kid_codes(p_codes text[])
returns table(cookie_code text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  return query
    select p.cookie_code
    from public.profiles p
    where p.cookie_code = any(p_codes)
      and p.cookie_code not like 'PARENT:%'
      and p.owner_user_id is not null
      and p.owner_user_id <> auth.uid();
end;
$$;

-- Same lockdown as every other RPC (see rls_lockdown.sql section 9): authenticated sessions only.
revoke execute on function public.rpc_unowned_kid_codes(text[]) from public;
revoke execute on function public.rpc_unowned_kid_codes(text[]) from anon;
grant execute on function public.rpc_unowned_kid_codes(text[]) to authenticated;
