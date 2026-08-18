-- deleteKidProfile (storage.ts) removes a kid from the parent's kids[] JSON but never touched the
-- kid's own `profiles` row (owner_user_id/user_id/bound_device_id) — under the new RLS, messages
-- access is granted via THAT row, not the JSON list, so a "deleted" kid would silently keep full
-- messaging ability forever. This RPC lets the owning parent actually revoke it.
create or replace function public.rpc_delete_kid_row(p_cookie_code text)
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

  delete from public.profiles
  where cookie_code = p_cookie_code
    and owner_user_id = auth.uid();

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function public.rpc_delete_kid_row(text) from public;
revoke execute on function public.rpc_delete_kid_row(text) from anon;
grant execute on function public.rpc_delete_kid_row(text) to authenticated;
