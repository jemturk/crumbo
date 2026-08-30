-- Collaborative drawings: both participants in a conversation can keep adding to the SAME
-- drawing for up to 12 hours after it was first sent. Each addition still lands as its own new,
-- immutable `messages` row (no vector/stroke history is persisted — the client re-flattens the
-- previous snapshot plus new strokes into one new PNG per contribution), so `messages`' existing
-- append-only posture (no update/delete policy) already covers "previous lines can't be
-- deleted/modified" for free. This migration only adds what's needed to (a) group a drawing's
-- contributions together and (b) enforce the 12-hour cutoff server-side rather than trusting the
-- client to hide the "keep drawing" button.

-- ============================================================================================
-- 1. drawing_sessions: a lightweight anchor, not a stroke store. Just enough to know who's
--    allowed to contribute and when the 12-hour window started.
-- ============================================================================================
create table public.drawing_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code_a text not null,
  code_b text not null
);

alter table public.drawing_sessions enable row level security;

create policy "drawing_sessions: read own" on public.drawing_sessions
  for select using (public.my_cookie_code() in (code_a, code_b));

create policy "drawing_sessions: create own" on public.drawing_sessions
  for insert with check (public.my_cookie_code() in (code_a, code_b));

-- No update/delete policy: immutable, same append-only posture as `messages`.

-- ============================================================================================
-- 2. messages: two new nullable columns. drawing_session_id links a contribution back to its
--    session; drawing_session_created_at is a redundant copy of that session's created_at so the
--    client never needs a join to know a message's expiry — it rides along on the realtime
--    INSERT payload, the offline AsyncStorage cache, and every plain select() as-is.
-- ============================================================================================
alter table public.messages
  add column if not exists drawing_session_id uuid references public.drawing_sessions(id),
  add column if not exists drawing_session_created_at timestamptz;

-- ============================================================================================
-- 3. Replace the messages insert policy: still "send as myself", plus, only when a message
--    carries a drawing_session_id, require that the referenced session (a) is still within its
--    12-hour window, (b) has sender_code/receiver_code exactly matching its own two participants
--    (order-independent) — without this, a caller could attach someone else's still-fresh session
--    id onto an unrelated conversation, since merely "the caller is a party to the session" isn't
--    enough to also guarantee the message's OTHER side is the session's real counterpart — and
--    (c) has a drawing_session_created_at that matches the session's real created_at, so the
--    redundant client-side cache can't be forged to look fresher than it is.
-- ============================================================================================
drop policy if exists "messages: send as myself" on public.messages;

create policy "messages: send as myself" on public.messages
  for insert with check (
    sender_code = public.my_cookie_code()
    and (
      drawing_session_id is null
      or exists (
        select 1 from public.drawing_sessions ds
        where ds.id = messages.drawing_session_id
          and now() <= ds.created_at + interval '12 hours'
          and sender_code in (ds.code_a, ds.code_b)
          and receiver_code in (ds.code_a, ds.code_b)
          and sender_code <> receiver_code
          and messages.drawing_session_created_at = ds.created_at
      )
    )
  );
