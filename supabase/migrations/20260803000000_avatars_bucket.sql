-- Crumbo: avatar photos for adult accounts (parents, and any relative added via
-- addRelativeToKidByEmail) — kids stick to the built-in emoji picker (AvatarPickerModal), but
-- grown-ups can upload a real photo instead of the "G" letter fallback shown otherwise.
--
-- Object paths are `${encodeURIComponent(email)}/avatar.jpg` — always the SAME path per
-- account, so re-uploading just overwrites it (no orphaned old files to clean up). The stored
-- URL has a cache-busting `?t=<timestamp>` query appended (see uploadParentAvatar) so clients
-- reliably see the new image instead of a stale cached copy of the same path.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Matches kid_media's intentionally permissive RLS (see that migration's note) — same
-- BUGS.md #1 caveat: real auth + RLS is a separately-tracked rework, not fixed here.
drop policy if exists "avatars anon full access (temporary)" on storage.objects;
create policy "avatars anon full access (temporary)"
  on storage.objects
  for all
  using (bucket_id = 'avatars')
  with check (bucket_id = 'avatars');
