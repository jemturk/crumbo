-- A few CRUM-* test rows from earlier smoke-testing slipped past the previous two cleanup
-- migrations (20260817000004, 20260817000006) because their owning "parent" in those runs was
-- itself an anonymous test session with no real email, so the fake-email-pattern match used
-- there didn't catch them. The app's real code generator (randomCookieCode() in storage.ts)
-- only ever produces 3-digit numeric codes (e.g. CRUM-367-890) — the leftover test rows contain
-- hex letters (e.g. CRUM-37b-b7f) since the test script generated codes differently, which
-- reliably distinguishes debris from real data regardless of which test run created it.
delete from public.messages
where (sender_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$' and sender_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$')
   or (receiver_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$' and receiver_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$');

delete from public.profiles
where cookie_code ~ '^CRUM-[0-9a-f]{3}-[0-9a-f]{3}$'
  and cookie_code !~ '^CRUM-[0-9]{3}-[0-9]{3}$';
