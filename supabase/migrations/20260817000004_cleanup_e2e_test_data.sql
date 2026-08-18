-- Removes the dummy rows created while smoke-testing the RLS/RPC rollout above (fake
-- e2e-*@test.local parent accounts, test kids, anonymous test sessions, and their test
-- messages). Zero real users exist yet, so a second full clean slate here is safe and simplest.
truncate table public.messages;
truncate table public.call_signals;
truncate table public.profiles;
delete from auth.users where email like 'e2e-%@test.local' or is_anonymous = true;
