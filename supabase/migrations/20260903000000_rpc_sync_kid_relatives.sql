-- Every adult connected to the same kid — the owning parent plus each relative added through
-- Add a Relative — should be able to chat with one another directly, without each pair having to
-- introduce themselves separately. A grandparent and an uncle who can both already reach Nora
-- shouldn't need a second, manual step to reach each other.
--
-- Materialised as a fan-out on write rather than derived at read time: the whole contact model is
-- built on each row's stored friends[] (getParentContacts reads exactly that, then refreshes each
-- entry's name/avatar live via rpc_get_parent_contact_public), so writing the links keeps every
-- existing reader working untouched and picks up profile changes for free. _patch_parent_friend
-- dedupes by cookieCode, so this whole function is idempotent and safe to re-run on every
-- relative added and every invite completed.
--
-- Deliberately NOT mirrored on removal: dropping a relative from one kid shouldn't silently tear
-- down conversations they may now share with the other adults, and two adults may well be linked
-- through more than one kid. Removing an adult-to-adult contact stays a separate, explicit act.
create or replace function public.rpc_sync_kid_relatives(p_kid_cookie_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kid_owner uuid;
  v_kid_user uuid;
  v_owner_code text;
  v_caller_code text;
  v_relatives text[];
  a text;
  b text;
  v_b_payload jsonb;
  v_b_name text;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select owner_user_id, user_id into v_kid_owner, v_kid_user
  from public.profiles where cookie_code = p_kid_cookie_code;
  if v_kid_owner is null then
    return jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  end if;

  -- A kid's relatives aren't stored on the kid's own row — they live in the OWNING parent's
  -- payload, nested under that kid's entry in kids[].friends[] (see _patch_kid_friend).
  select cookie_code into v_owner_code
  from public.profiles
  where user_id = v_kid_owner and cookie_code like 'PARENT:%';
  if v_owner_code is null then
    return jsonb_build_object('success', false, 'error', 'NO_OWNER_ROW');
  end if;

  select coalesce(array_agg(distinct f_code), '{}'::text[]) into v_relatives
  from (
    select f ->> 'cookieCode' as f_code
    from public.profiles p,
         lateral jsonb_array_elements(coalesce(p.push_token::jsonb -> 'kids', '[]'::jsonb)) k,
         lateral jsonb_array_elements(coalesce(k -> 'friends', '[]'::jsonb)) f
    where p.cookie_code = v_owner_code
      and k ->> 'cookieCode' = p_kid_cookie_code
  ) s
  where f_code like 'PARENT:%';

  -- The owning parent is one of this kid's adults too. They're normally already listed among
  -- their own kid's friends (that's what lets the kid chat with them), but don't depend on it.
  if not (v_owner_code = any(v_relatives)) then
    v_relatives := v_relatives || v_owner_code;
  end if;

  -- Callable by the kid's owner, by the kid, or by any adult already connected to this kid. That
  -- last case is the one that matters: it lets a freshly-invited relative complete the mesh
  -- themselves immediately after signing up (see StorageService.completePendingRelativeLinks),
  -- when they demonstrably do not own the kid and never will.
  select cookie_code into v_caller_code from public.profiles where user_id = auth.uid();
  if not (
    v_kid_owner = auth.uid()
    or v_kid_user = auth.uid()
    or (v_caller_code is not null and v_caller_code = any(v_relatives))
  ) then
    raise exception 'FORBIDDEN';
  end if;

  foreach a in array v_relatives loop
    foreach b in array v_relatives loop
      continue when a = b;

      select push_token::jsonb into v_b_payload from public.profiles where cookie_code = b;
      -- An invited relative who hasn't finished signing up has no row yet — skip them; they pick
      -- the mesh up themselves when this runs again on their first sign-in.
      continue when v_b_payload is null;

      -- Each adult's OWN parentName, not the nickname whoever invited them happened to type:
      -- "Grandma" is meaningful to the kid's parent, but is not how this person should show up
      -- to an uncle who has never met them. Only a fallback either way, since getParentContacts
      -- re-reads the live name and avatar per entry at display time.
      v_b_name := coalesce(nullif(v_b_payload ->> 'parentName', ''), replace(b, 'PARENT:', ''));

      update public.profiles
      set push_token = public._patch_parent_friend(
        push_token, b, v_b_name,
        coalesce(v_b_payload ->> 'parentAvatarEmoji', '👤'),
        v_b_payload ->> 'parentAvatarUrl'
      )
      where cookie_code = a;
    end loop;
  end loop;

  return jsonb_build_object('success', true, 'relatives', coalesce(array_length(v_relatives, 1), 0));
end;
$$;

-- Same lockdown as every other RPC (see rls_lockdown.sql section 9): authenticated sessions only.
revoke execute on function public.rpc_sync_kid_relatives(text) from public;
revoke execute on function public.rpc_sync_kid_relatives(text) from anon;
grant execute on function public.rpc_sync_kid_relatives(text) to authenticated;
