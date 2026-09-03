-- Inviting a relative used to go through admin.inviteUserByEmail, which PRE-CREATES an auth
-- account for the invitee. That single choice forced everything awkward about the old flow: the
-- account existed but had no password, so it had to be *claimed* rather than simply signed up
-- for, claiming meant proving inbox control, and proving inbox control meant typing a 6-digit
-- code out of an email. It also meant a second invite to the same address collided with the
-- half-made account left by the first (hence the delete-and-reinvite workaround that lived in
-- invite-relative).
--
-- Nothing about the *relationship* required an account to exist early — only the notification
-- did. So the pending link now waits here, keyed by email, until somebody signs in as that
-- address. The invitee just installs Crumbo and registers completely normally; the kid is already
-- waiting when they arrive.
--
-- Security is unchanged: registration already requires confirming the email address, so both the
-- old code and this table rest on exactly the same proof — control of that inbox.
create table if not exists public.pending_relative_links (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kid_cookie_code text not null,
  kid_name text not null,
  kid_avatar_emoji text,
  created_at timestamptz not null default now(),
  unique (email, kid_cookie_code)
);

create index if not exists pending_relative_links_email_idx
  on public.pending_relative_links (email);

-- RLS on with NO policies at all, deliberately: this table is reachable only through the two
-- security-definer functions below. A client that could read it directly could enumerate which
-- addresses have been invited to which kid, which is exactly the kind of thing an app for
-- children should not leak.
alter table public.pending_relative_links enable row level security;

-- Unchanged signature (so existing grants and callers still apply). Only the else-branch is new:
-- when the relative has no account yet, park the link here instead of relying on an auth account
-- being conjured up to carry it in user_metadata.
create or replace function public.rpc_add_relative_to_kid(
  p_kid_cookie_code text,
  p_kid_name text,
  p_kid_avatar_emoji text,
  p_relative_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_relative_code text := 'PARENT:' || lower(p_relative_email);
  v_relative_exists boolean;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select owner_user_id into v_owner from public.profiles
  where cookie_code = p_kid_cookie_code and (owner_user_id = auth.uid() or user_id = auth.uid());
  if v_owner is null then
    raise exception 'FORBIDDEN';
  end if;

  select exists(select 1 from public.profiles where cookie_code = v_relative_code) into v_relative_exists;

  if v_relative_exists then
    update public.profiles
    set push_token = public._patch_parent_friend(push_token, p_kid_cookie_code, p_kid_name, coalesce(p_kid_avatar_emoji, '🍪'), null)
    where cookie_code = v_relative_code;
  else
    insert into public.pending_relative_links (email, kid_cookie_code, kid_name, kid_avatar_emoji)
    values (lower(p_relative_email), p_kid_cookie_code, p_kid_name, p_kid_avatar_emoji)
    on conflict (email, kid_cookie_code) do update
      set kid_name = excluded.kid_name,
          kid_avatar_emoji = excluded.kid_avatar_emoji,
          created_at = now();
  end if;

  return jsonb_build_object('success', true, 'linked', v_relative_exists);
end;
$$;

-- Called on every sign-in (see StorageService.claimPendingRelativeLinks). Applies the contacts
-- AND clears the pending rows in one transaction on purpose: if the client were handed the links
-- and trusted to write them itself, a crash between the two would consume the invite without ever
-- delivering the contact, stranding the relative with no way to recover except asking the parent
-- to invite them again.
create or replace function public.rpc_claim_pending_relative_links()
returns table(kid_cookie_code text, kid_name text, kid_avatar_emoji text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_my_code text;
  v_links jsonb;
  v_link jsonb;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  if v_email is null then
    return; -- anonymous kid session; nothing addressed to it
  end if;

  -- Claim only once this caller actually has a row to write the contacts into. Returning early
  -- WITHOUT deleting means a sign-in that races account creation just picks the links up on the
  -- next one, rather than silently burning them.
  select p.cookie_code into v_my_code
  from public.profiles p
  where p.user_id = auth.uid() and p.cookie_code like 'PARENT:%';
  if v_my_code is null then
    return;
  end if;

  with d as (
    delete from public.pending_relative_links p
    where p.email = v_email
    returning p.kid_cookie_code, p.kid_name, p.kid_avatar_emoji
  )
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into v_links from d;

  -- Folded one at a time rather than in a single set-based update: _patch_parent_friend rewrites
  -- the whole payload per call, so each iteration has to see the previous one's result. A
  -- relative invited for two siblings gets both, which a single update would silently not do.
  for v_link in select * from jsonb_array_elements(v_links) loop
    update public.profiles
    set push_token = public._patch_parent_friend(
      push_token,
      v_link ->> 'kid_cookie_code',
      v_link ->> 'kid_name',
      coalesce(v_link ->> 'kid_avatar_emoji', '🍪'),
      null
    )
    where cookie_code = v_my_code;
  end loop;

  return query
  select l ->> 'kid_cookie_code', l ->> 'kid_name', l ->> 'kid_avatar_emoji'
  from jsonb_array_elements(v_links) l;
end;
$$;

revoke execute on function public.rpc_claim_pending_relative_links() from public;
revoke execute on function public.rpc_claim_pending_relative_links() from anon;
grant execute on function public.rpc_claim_pending_relative_links() to authenticated;
