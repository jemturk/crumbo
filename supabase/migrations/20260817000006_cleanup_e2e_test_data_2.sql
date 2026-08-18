-- Cleanup for the second round of smoke-test data created while verifying the
-- rpc_read_owned_parent_row ambiguous-column fix above. Surgical this time (not a full
-- truncate) — a real user is actively testing against this project right now and has their own
-- in-progress parent/kid rows that must not be touched.
delete from public.messages
where sender_code like 'PARENT:e2e-%' or receiver_code like 'PARENT:e2e-%'
  or sender_code like 'PARENT:quickcheck-%' or receiver_code like 'PARENT:quickcheck-%';
delete from public.profiles where cookie_code like 'PARENT:e2e-%' or cookie_code like 'PARENT:quickcheck-%';
delete from public.profiles
where owner_user_id in (select id from auth.users where email like 'e2e-%@test.local' or email like 'quickcheck-%@test.local')
   or user_id in (select id from auth.users where email like 'e2e-%@test.local' or email like 'quickcheck-%@test.local' or is_anonymous = true);
delete from auth.users where email like 'e2e-%@test.local' or email like 'quickcheck-%@test.local';
delete from auth.users
where is_anonymous = true
  and id not in (select user_id from public.profiles where user_id is not null)
  and id not in (select owner_user_id from public.profiles where owner_user_id is not null);
