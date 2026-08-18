-- Cleanup for the final client/server password-policy alignment check above.
delete from auth.users where email like 'alignedpw-%@test.local';
