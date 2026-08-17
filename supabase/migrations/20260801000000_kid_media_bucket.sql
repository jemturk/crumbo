-- Crumbo: shared media bucket for kid-sent photos and hand-drawn sketches.
--
-- Both are uploaded as a single resized/compressed JPEG (photos) or PNG (drawings) and
-- referenced from `messages.text` via the [IMAGE:<url>] / [DRAWING:<url>] prefix convention
-- (see storage.ts sendImageMessage / sendDrawingMessage) — no new columns on `messages`.
-- Object paths are `${senderCookieCode}/${kind}_${uuid}.${ext}`, so no DB row is needed to
-- track uploads; `getPublicUrl()` gives a stable, unsigned URL since the bucket is public.

insert into storage.buckets (id, name, public)
values ('kid_media', 'kid_media', true)
on conflict (id) do nothing;

-- NOTE: RLS is intentionally left permissive here, matching how `messages`, `profiles`, and
-- `call_signals` are accessed with the anon key today (see BUGS.md #1 — real auth + RLS is a
-- separately-tracked rework, not fixed by this migration). Anyone with the anon key can
-- upload to / read from this bucket, same as they already can read/write any row in
-- `messages`. Scoped to this bucket only (`bucket_id = 'kid_media'`), so it's additive next
-- to any other bucket policies rather than a blanket grant on storage.objects.
drop policy if exists "kid_media anon full access (temporary)" on storage.objects;
create policy "kid_media anon full access (temporary)"
  on storage.objects
  for all
  using (bucket_id = 'kid_media')
  with check (bucket_id = 'kid_media');
