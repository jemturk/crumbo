-- Cleanup for the generate-agora-token/notify-call fix verification above. Same surgical
-- approach as the previous cleanups — a real user has live data in this project.
delete from public.profiles where cookie_code like 'PARENT:verify-%';
delete from public.profiles
where cookie_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$'
  and cookie_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$';
delete from auth.users where email like 'verify-%@test.local';
delete from auth.users
where is_anonymous = true
  and id not in (select user_id from public.profiles where user_id is not null)
  and id not in (select owner_user_id from public.profiles where owner_user_id is not null);
