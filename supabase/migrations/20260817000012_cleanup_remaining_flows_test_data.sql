-- Cleanup for the adversarial verification of the remaining (previously-untested) RPCs:
-- rpc_pair_parents, rpc_add_relative_to_kid, rpc_check_friend_pairing_status,
-- rpc_get_parent_contact_public, rpc_delete_kid_row, and cross-family isolation.
delete from public.profiles where cookie_code like 'PARENT:remcheck-%';
delete from public.profiles
where cookie_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$'
  and cookie_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$';
delete from auth.users where email like 'remcheck-%@test.local';
delete from auth.users
where is_anonymous = true
  and id not in (select user_id from public.profiles where user_id is not null)
  and id not in (select owner_user_id from public.profiles where owner_user_id is not null);
