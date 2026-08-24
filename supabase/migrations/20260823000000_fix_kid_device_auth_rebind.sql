-- rpc_bind_kid_device_auth's own comment says bound_device_id matching p_device_id IS the real
-- authorization check here ("preventing an arbitrary anonymous session from claiming any kid by
-- guessing their code") — but the function's WHERE clause also required the row's EXISTING
-- user_id to be null or already equal to the caller's auth.uid(), which isn't an extra security
-- gate, just an accidental idempotency check. In practice it makes the function self-defeating
-- for its main purpose: ensureKidSession (src/services/storage.ts) calls it to recover a kid
-- device whose Supabase Auth session was lost (app data cleared, reinstalled, anon session
-- otherwise invalidated) by signing in fresh and rebinding. But the row's user_id still holds the
-- OLD (now-dead) anon uid, which never matches the freshly-generated one, so the UPDATE always
-- matched zero rows and the rebind silently failed forever — the kid device could never send a
-- message or sync again (every RLS check via my_cookie_code() kept resolving to nothing).
--
-- Fix: drop the user_id condition. bound_device_id = p_device_id, set by rpc_activate_kid under
-- the OWNING PARENT's session, remains the sole (and, per the function's original comment,
-- intended) authorization check.
create or replace function public.rpc_bind_kid_device_auth(p_cookie_code text, p_device_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  update public.profiles
  set user_id = auth.uid()
  where cookie_code = p_cookie_code
    and bound_device_id = p_device_id;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
