-- kid_media was a public bucket, meaning anyone with a file's URL could view it directly with
-- zero authentication, bypassing RLS entirely — a third way to read sensitive chat media beyond
-- "legitimate kid/parent privileges" or "a stolen parent password". Making it private moves all
-- reads through the new get-media-url Edge Function, which issues short-lived signed URLs only
-- after verifying the caller actually uploaded the file or shares a conversation with whoever did.
--
-- storage.objects RLS on this bucket (kid_media: rw own folder, from the RLS lockdown migration)
-- is unaffected by this — it already restricted SDK-level list/upload/delete to the uploader's
-- own folder; it just now also matters for reads, since there's no more public-URL bypass.
update storage.buckets set public = false where id = 'kid_media';
