-- Security lockdown: RLS was disabled/fully permissive on `messages`, `profiles`, `call_signals`,
-- and the `kid_media`/`avatars` storage buckets — confirmed via Supabase's own advisor
-- (rls_disabled_in_public) and directly: querying any of these with nothing but the public anon
-- key (shipped in every app install) returned every row, with no restriction at all.
--
-- Kids have no real Supabase Auth identity today — they're a client-side `cookie_code` string
-- with no session. This migration gives every kid a real anonymous-auth identity (bound at
-- activation time) and normalizes the security-critical fields (who owns a kid row, which
-- device it's bound to) into real columns, while leaving the existing settings/friends JSON
-- blob on the parent's row untouched as a display cache — only who's allowed to read/write it
-- changes.
--
-- There are zero real users in production yet, so this ships as a clean cutover: existing rows
-- are wiped rather than migrated, and there's no backward-compatibility path for pre-this-
-- migration clients.

-- ============================================================================================
-- 0. Clean slate — no real users yet, nothing here is worth preserving.
-- ============================================================================================
truncate table public.messages;
truncate table public.call_signals;
truncate table public.profiles;
-- storage.objects can't be DELETEd directly (Supabase blocks it, "use the Storage API instead")
-- — kid_media/avatars are cleared separately via the Storage API/CLI, not in this migration.

-- ============================================================================================
-- 1. Schema: normalize ownership/auth-binding onto real columns.
-- ============================================================================================
alter table public.profiles
  add column if not exists user_id uuid references auth.users(id),
  add column if not exists owner_user_id uuid references auth.users(id),
  add column if not exists bound_device_id text;

create unique index if not exists profiles_user_id_key on public.profiles (user_id) where user_id is not null;
create index if not exists profiles_owner_user_id_idx on public.profiles (owner_user_id) where owner_user_id is not null;
create index if not exists profiles_cookie_code_idx on public.profiles (cookie_code);

-- ============================================================================================
-- 2. Drop the old "anon full access (temporary)" policies.
-- ============================================================================================
drop policy if exists "call_signals anon full access (temporary)" on public.call_signals;
drop policy if exists "kid_media anon full access (temporary)" on storage.objects;
drop policy if exists "avatars anon full access (temporary)" on storage.objects;

alter table public.messages enable row level security;
alter table public.profiles enable row level security;
-- call_signals already had RLS enabled; only its permissive policy needed dropping.

-- ============================================================================================
-- 3. Helper: resolve the caller's own cookie_code from their auth session. SECURITY DEFINER so
--    it can be used inside RLS policies without recursing back through profiles' own policy.
--    Anonymous Supabase Auth sessions (kids) still populate auth.uid() under the `authenticated`
--    role, so this works uniformly for kids and parents.
-- ============================================================================================
create or replace function public.my_cookie_code()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select cookie_code from public.profiles where user_id = auth.uid() limit 1;
$$;

revoke execute on function public.my_cookie_code() from public;
grant execute on function public.my_cookie_code() to authenticated;

-- ============================================================================================
-- 4. profiles: direct access is own-row only. Every cross-row operation goes through an RPC.
-- ============================================================================================
create policy "profiles: read own row" on public.profiles
  for select using (user_id = auth.uid());

create policy "profiles: insert own row" on public.profiles
  for insert with check (user_id = auth.uid());

create policy "profiles: update own row" on public.profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================================
-- 5. messages: sender/receiver, plus a parental-oversight clause so a parent can still read the
--    chat history of any kid they own (getChatLogsForParent) without owning either cookie_code
--    themselves.
-- ============================================================================================
create policy "messages: read own or owned-kid" on public.messages
  for select using (
    sender_code = public.my_cookie_code()
    or receiver_code = public.my_cookie_code()
    or sender_code in (select cookie_code from public.profiles where owner_user_id = auth.uid())
    or receiver_code in (select cookie_code from public.profiles where owner_user_id = auth.uid())
  );

create policy "messages: send as myself" on public.messages
  for insert with check (sender_code = public.my_cookie_code());

-- No update/delete policy: chat history is append-only from the client's perspective.

-- ============================================================================================
-- 6. call_signals: sender/receiver only — no oversight clause needed for live call signaling.
-- ============================================================================================
create policy "call_signals: read mine" on public.call_signals
  for select using (
    sender_code = public.my_cookie_code() or receiver_code = public.my_cookie_code()
  );

create policy "call_signals: send as myself" on public.call_signals
  for insert with check (sender_code = public.my_cookie_code());

-- ============================================================================================
-- 7. Storage buckets. Both buckets are public (public=true) — a direct-URL GET (how <Image>
--    renders message media and avatars) bypasses storage.objects RLS entirely by design, so
--    rendering is unaffected by anything below. These policies govern only the SDK-mediated
--    paths (upload/list/remove), which is what actually stops "anyone can overwrite or delete
--    anyone's files" and API-level enumeration of every user's file paths.
-- ============================================================================================
create policy "kid_media: rw own folder" on storage.objects
  for all using (
    bucket_id = 'kid_media' and (storage.foldername(name))[1] = public.my_cookie_code()
  )
  with check (
    bucket_id = 'kid_media' and (storage.foldername(name))[1] = public.my_cookie_code()
  );

-- avatars paths are keyed by the parent's raw email (see compressAndUploadAvatar/
-- uploadParentAvatar in src/services/storage.ts), not cookie_code.
create policy "avatars: rw own folder" on storage.objects
  for all using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = (auth.jwt() ->> 'email')
  )
  with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = (auth.jwt() ->> 'email')
  );

-- ============================================================================================
-- 8. RPCs. Every function derives the caller's own identity from auth.uid() and never trusts a
--    client-supplied "this is who I am" argument for the caller's own side of an operation —
--    today's pairing/relative functions have no such check at all and are forgeable by anyone
--    holding the anon key; that's fixed here, not just carried forward.
-- ============================================================================================

-- Parent creates a new kid row (called right after generateUniqueCookieCode() succeeds).
create or replace function public.rpc_create_kid_row(p_cookie_code text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  insert into public.profiles (cookie_code, name, owner_user_id)
  values (p_cookie_code, p_name, auth.uid());
end;
$$;

-- O(1) collision check — replaces generateUniqueCookieCode's LIKE-scan now that kid rows are real.
create or replace function public.rpc_check_cookie_code_available(p_candidate text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists(select 1 from public.profiles where cookie_code = p_candidate);
$$;

-- Atomic device-claim (closes the check-then-write race the old two-round-trip version had).
create or replace function public.rpc_activate_kid(p_cookie_code text, p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_bound text;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select owner_user_id, bound_device_id into v_owner, v_bound
  from public.profiles
  where cookie_code = p_cookie_code
  for update;

  if not found or v_owner is distinct from auth.uid() then
    -- Same response whether the code doesn't exist or just isn't yours — don't leak which.
    return jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  end if;

  if v_bound is not null and v_bound <> p_device_id then
    return jsonb_build_object('success', false, 'error', 'ALREADY_ACTIVE_ELSEWHERE');
  end if;

  update public.profiles set bound_device_id = p_device_id where cookie_code = p_cookie_code;
  return jsonb_build_object('success', true);
end;
$$;

-- Called by a freshly anonymous-signed-in session to bind auth to the row the parent just
-- activated. Only succeeds if bound_device_id already matches — that's the real authorization
-- check, preventing an arbitrary anonymous session from claiming any kid by guessing their code.
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
    and bound_device_id = p_device_id
    and (user_id is null or user_id = auth.uid());

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Owning parent or the kid itself. Nulling user_id immediately revokes the old device's session
-- even though its JWT is still technically valid — RLS re-checks profiles.user_id = auth.uid()
-- live on every query, so a stale device loses access the instant this runs.
create or replace function public.rpc_deactivate_kid(p_cookie_code text)
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
  set bound_device_id = null, user_id = null
  where cookie_code = p_cookie_code
    and (owner_user_id = auth.uid() or user_id = auth.uid());

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Read the settings/friends JSON blob on the owning parent's row — same authorization shape as
-- write below. Used wherever the client today scans for "the parent row that owns this kid".
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

  select owner_user_id into v_owner from public.profiles where cookie_code = p_kid_cookie_code;
  if v_owner is null or not (
    v_owner = auth.uid()
    or exists (select 1 from public.profiles where cookie_code = p_kid_cookie_code and user_id = auth.uid())
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return query
    select p.cookie_code, p.push_token, p.name
    from public.profiles p
    where p.user_id = v_owner;
end;
$$;

create or replace function public.rpc_write_owned_parent_row(p_kid_cookie_code text, p_push_token text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select owner_user_id into v_owner from public.profiles where cookie_code = p_kid_cookie_code;
  if v_owner is null or not (
    v_owner = auth.uid()
    or exists (select 1 from public.profiles where cookie_code = p_kid_cookie_code and user_id = auth.uid())
  ) then
    raise exception 'FORBIDDEN';
  end if;

  update public.profiles
  set push_token = p_push_token, name = p_name
  where user_id = v_owner;
end;
$$;

-- Pairing-flow read: does p_friend_cookie_code's owning parent's kid entry list me as a friend
-- yet? Caller's own identity is derived from auth.uid(), never trusted from a parameter.
create or replace function public.rpc_check_friend_pairing_status(p_friend_cookie_code text)
returns table(status text, avatar_emoji text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_my_code text;
  v_owner uuid;
  v_payload jsonb;
  v_kid jsonb;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select cookie_code into v_my_code from public.profiles where user_id = auth.uid();
  if v_my_code is null then
    raise exception 'NOT_ACTIVATED';
  end if;

  select owner_user_id into v_owner from public.profiles where cookie_code = p_friend_cookie_code;
  if v_owner is null then
    return query select 'pending'::text, null::text;
    return;
  end if;

  select push_token::jsonb into v_payload from public.profiles where user_id = v_owner;

  select elem into v_kid
  from jsonb_array_elements(coalesce(v_payload -> 'kids', '[]'::jsonb)) elem
  where elem ->> 'cookieCode' = p_friend_cookie_code
  limit 1;

  if v_kid is null then
    return query select 'pending'::text, null::text;
    return;
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(v_kid -> 'friends', '[]'::jsonb)) f
    where f ->> 'cookieCode' = v_my_code
  ) then
    return query select 'paired'::text, (v_kid ->> 'avatarEmoji');
  else
    return query select 'pending'::text, (v_kid ->> 'avatarEmoji');
  end if;
end;
$$;

-- Minimal public display info for an already-known paired parent contact (getParentContacts'
-- cross-row refresh). Deliberately narrow — name/avatar only, never the full settings blob.
create or replace function public.rpc_get_parent_contact_public(p_cookie_code text)
returns table(name text, avatar_url text, avatar_emoji text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  select push_token::jsonb into v_payload from public.profiles where cookie_code = p_cookie_code;
  if v_payload is null then
    return;
  end if;
  return query select
    (v_payload ->> 'parentName'),
    (v_payload ->> 'parentAvatarUrl'),
    (v_payload ->> 'parentAvatarEmoji');
end;
$$;

-- Shared JSON-patch helper: add one friend entry into ONE specific kid's `friends[]`, deduped by
-- cookie_code. Used by rpc_pair_kids / rpc_add_relative_to_kid so the patch logic lives in one place.
create or replace function public._patch_kid_friend(
  p_payload text,
  p_target_kid_code text,
  p_friend_code text,
  p_friend_name text,
  p_friend_avatar_emoji text,
  p_friend_avatar_url text
)
returns text
language sql
set search_path = public
as $$
  select jsonb_set(
    coalesce(p_payload::jsonb, '{}'::jsonb),
    '{kids}',
    coalesce((
      select jsonb_agg(
        case
          when k ->> 'cookieCode' = p_target_kid_code
            and not exists (
              select 1 from jsonb_array_elements(coalesce(k -> 'friends', '[]'::jsonb)) f
              where f ->> 'cookieCode' = p_friend_code
            )
          then jsonb_set(
            k, '{friends}',
            coalesce(k -> 'friends', '[]'::jsonb) || jsonb_build_object(
              'id', gen_random_uuid()::text,
              'name', p_friend_name,
              'cookieCode', p_friend_code,
              'avatarEmoji', p_friend_avatar_emoji,
              'avatarUrl', p_friend_avatar_url
            )
          )
          else k
        end
      )
      from jsonb_array_elements(coalesce(p_payload::jsonb -> 'kids', '[]'::jsonb)) k
    ), '[]'::jsonb)
  )::text
$$;

-- Same shape, but for a PARENT row's top-level `friends[]` (paired parents/relatives), not a
-- nested kid entry.
create or replace function public._patch_parent_friend(
  p_payload text,
  p_friend_code text,
  p_friend_name text,
  p_friend_avatar_emoji text,
  p_friend_avatar_url text
)
returns text
language sql
set search_path = public
as $$
  select case
    when exists (
      select 1 from jsonb_array_elements(coalesce(p_payload::jsonb -> 'friends', '[]'::jsonb)) f
      where f ->> 'cookieCode' = p_friend_code
    ) then p_payload
    else jsonb_set(
      coalesce(p_payload::jsonb, '{}'::jsonb),
      '{friends}',
      coalesce(p_payload::jsonb -> 'friends', '[]'::jsonb) || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', p_friend_name,
        'cookieCode', p_friend_code,
        'avatarEmoji', p_friend_avatar_emoji,
        'avatarUrl', p_friend_avatar_url
      )
    )::text
  end
$$;

-- QR pairing between two kids. p_kid_cookie_code must belong to the caller — verified via
-- user_id, not trusted from the argument (today's version trusts it outright).
create or replace function public.rpc_pair_kids(
  p_kid_cookie_code text,
  p_kid_name text,
  p_kid_avatar_emoji text,
  p_friend_cookie_code text,
  p_friend_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_my_owner uuid;
  v_friend_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select owner_user_id into v_my_owner from public.profiles
  where cookie_code = p_kid_cookie_code and user_id = auth.uid();
  if v_my_owner is null then
    raise exception 'FORBIDDEN';
  end if;

  select owner_user_id into v_friend_owner from public.profiles where cookie_code = p_friend_cookie_code;
  if v_friend_owner is null then
    return jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  end if;

  update public.profiles
  set push_token = public._patch_kid_friend(push_token, p_friend_cookie_code, p_kid_cookie_code, p_kid_name, p_kid_avatar_emoji, null)
  where user_id = v_friend_owner;

  update public.profiles
  set push_token = public._patch_kid_friend(push_token, p_kid_cookie_code, p_friend_cookie_code, p_friend_name, '🍪', null)
  where user_id = v_my_owner;

  return jsonb_build_object('success', true);
end;
$$;

-- QR pairing between two parents — caller's own identity derived from auth.uid(), not trusted
-- from an argument.
create or replace function public.rpc_pair_parents(
  p_my_name text,
  p_friend_parent_code text,
  p_friend_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_my_code text;
  v_my_payload jsonb;
  v_friend_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select cookie_code, push_token::jsonb into v_my_code, v_my_payload
  from public.profiles where user_id = auth.uid();
  if v_my_code is null or v_my_code not like 'PARENT:%' then
    raise exception 'NOT_A_PARENT';
  end if;
  if v_my_code = p_friend_parent_code then
    return jsonb_build_object('success', false, 'error', 'SELF');
  end if;

  select push_token::jsonb into v_friend_payload from public.profiles where cookie_code = p_friend_parent_code;
  if v_friend_payload is null then
    return jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  end if;

  update public.profiles
  set push_token = public._patch_parent_friend(
    push_token, p_friend_parent_code, p_friend_name,
    coalesce(v_friend_payload ->> 'parentAvatarEmoji', '👤'), v_friend_payload ->> 'parentAvatarUrl'
  )
  where cookie_code = v_my_code;

  update public.profiles
  set push_token = public._patch_parent_friend(
    push_token, v_my_code, p_my_name,
    coalesce(v_my_payload ->> 'parentAvatarEmoji', '👤'), v_my_payload ->> 'parentAvatarUrl'
  )
  where cookie_code = p_friend_parent_code;

  return jsonb_build_object('success', true);
end;
$$;

-- Adds a kid as a contact on an EXISTING relative's row. Caller must own p_kid_cookie_code
-- (parent or the kid itself) — verified server-side, not trusted from the argument.
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
  v_relative_code text := 'PARENT:' || p_relative_email;
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
  end if;

  return jsonb_build_object('success', true, 'linked', v_relative_exists);
end;
$$;

-- ============================================================================================
-- 9. Lock down execution to authenticated sessions only (anonymous kid sessions still carry the
--    `authenticated` role once signed in, so this doesn't affect them — it excludes only fully
--    unauthenticated `anon`-role requests).
-- ============================================================================================
do $$
declare
  fn text;
begin
  foreach fn in array array[
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
    execute format('revoke execute on function public.%s from public;', fn);
    execute format('grant execute on function public.%s to authenticated;', fn);
  end loop;
end $$;
