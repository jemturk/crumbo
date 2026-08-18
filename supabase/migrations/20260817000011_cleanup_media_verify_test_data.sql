-- Cleanup for the get-media-url / private-bucket verification above.
delete from public.messages
where sender_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$' and sender_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$'
   or receiver_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$' and receiver_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$';
delete from public.profiles where cookie_code like 'PARENT:mediaverify-%';
delete from public.profiles
where cookie_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$'
  and cookie_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$';
delete from auth.users where email like 'mediaverify-%@test.local';
delete from auth.users
where is_anonymous = true
  and id not in (select user_id from public.profiles where user_id is not null)
  and id not in (select owner_user_id from public.profiles where owner_user_id is not null);
