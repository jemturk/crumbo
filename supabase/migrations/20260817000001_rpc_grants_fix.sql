-- Supabase's default project setup grants EXECUTE on every new public-schema function to the
-- `anon` role directly (not just via the PUBLIC pseudo-role), via ALTER DEFAULT PRIVILEGES set up
-- at project creation. The previous migration only revoked from PUBLIC, so every RPC added there
-- was still callable by a fully unauthenticated anon-key request — confirmed empirically:
-- rpc_check_cookie_code_available returned a real result to a plain anon-key curl call. Revoking
-- from `anon` explicitly here closes that.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'my_cookie_code()',
    'rpc_create_kid_row(text, text)',
    'rpc_check_cookie_code_available(text)',
    'rpc_activate_kid(text, text)',
    'rpc_bind_kid_device_auth(text, text)',
    'rpc_deactivate_kid(text)',
    'rpc_read_owned_parent_row(text)',
    'rpc_write_owned_parent_row(text, text, text)',
    'rpc_check_friend_pairing_status(text)',
    'rpc_get_parent_contact_public(text)',
    'rpc_pair_kids(text, text, text, text, text)',
    'rpc_pair_parents(text, text, text)',
    'rpc_add_relative_to_kid(text, text, text, text)'
  ]
  loop
    execute format('revoke execute on function public.%s from anon;', fn);
  end loop;
end $$;

-- Also add the same "must be authenticated" guard this function was missing internally (every
-- other RPC has one) — belt-and-suspenders now that the grant itself is fixed.
create or replace function public.rpc_check_cookie_code_available(p_candidate text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  return not exists(select 1 from public.profiles where cookie_code = p_candidate);
end;
$$;

revoke execute on function public.rpc_check_cookie_code_available(text) from anon;
grant execute on function public.rpc_check_cookie_code_available(text) to authenticated;
