-- Bug found via end-to-end smoke test: the messages SELECT policy's parental-oversight clause
-- (`sender_code IN (SELECT cookie_code FROM profiles WHERE owner_user_id = auth.uid())`) silently
-- returned nothing for a real parent session. The subquery runs under the CALLER's own
-- privileges, not the policy definer's, so it's itself subject to profiles' own RLS ("select your
-- own row only") — from a parent's session, a query against their KID's row (user_id = the kid's
-- uid, not the parent's) is filtered out by that policy before the outer `owner_user_id = auth.uid()`
-- filter even gets a chance to match. Same class of problem my_cookie_code() was built to dodge by
-- being SECURITY DEFINER; the oversight clause just wasn't routed through an equivalent function.
create or replace function public.my_owned_kid_codes()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select cookie_code from public.profiles where owner_user_id = auth.uid();
$$;

revoke execute on function public.my_owned_kid_codes() from public;
revoke execute on function public.my_owned_kid_codes() from anon;
grant execute on function public.my_owned_kid_codes() to authenticated;

drop policy if exists "messages: read own or owned-kid" on public.messages;
create policy "messages: read own or owned-kid" on public.messages
  for select using (
    sender_code = public.my_cookie_code()
    or receiver_code = public.my_cookie_code()
    or sender_code in (select public.my_owned_kid_codes())
    or receiver_code in (select public.my_owned_kid_codes())
  );
