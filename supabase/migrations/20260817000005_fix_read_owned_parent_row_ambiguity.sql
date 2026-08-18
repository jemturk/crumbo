-- Bug found live: activating a kid failed with a generic error. Root cause —
-- rpc_read_owned_parent_row RETURNS TABLE(cookie_code text, push_token text, name text), and
-- PL/pgSQL implicitly declares those as variables in scope for the whole function body. The
-- unqualified `where cookie_code = p_kid_cookie_code` checks are ambiguous between that variable
-- and public.profiles.cookie_code (confirmed via direct RPC call: "column reference \"cookie_code\"
-- is ambiguous", SQLSTATE 42702) — activateKidOnThisDevice calls this immediately after
-- rpc_activate_kid succeeds, so every activation failed here. Fixed by qualifying every reference
-- to the table with an alias throughout.
create or replace function public.rpc_read_owned_parent_row(p_kid_cookie_code text)
returns table(cookie_code text, push_token text, name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select k.owner_user_id into v_owner from public.profiles k where k.cookie_code = p_kid_cookie_code;
  if v_owner is null or not (
    v_owner = auth.uid()
    or exists (select 1 from public.profiles k where k.cookie_code = p_kid_cookie_code and k.user_id = auth.uid())
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return query
    select p.cookie_code, p.push_token, p.name
    from public.profiles p
    where p.user_id = v_owner;
end;
$$;
