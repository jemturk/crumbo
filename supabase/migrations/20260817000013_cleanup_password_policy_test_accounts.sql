-- Cleanup for the password-policy verification above (a weak-password attempt that was rejected
-- outright, and one real unconfirmed test signup created to confirm a strong password is accepted).
delete from auth.users where email like 'weakpwtest-%@test.local' or email like 'strongpwtest-%@test.local';
