-- Crumbo: dedicated call signaling channel.
--
-- Call control events (START/ACCEPT/DECLINE/END/CANCEL) used to be inserted into the
-- `messages` table as JSON and filtered back out on every client. They now live here,
-- so `messages` holds only real chat + [CALL_LOG:*] history.
--
-- Rows are ephemeral: they exist only to be delivered via Realtime to the receiver.
-- A short retention window keeps the table tiny; nothing reads history from it.

create table if not exists public.call_signals (
  id           uuid primary key default gen_random_uuid(),
  call_uuid    text not null,
  type         text not null,               -- START_AUDIO_CALL | START_VIDEO_CALL | ACCEPT_CALL | DECLINE_CALL | END_CALL | CANCEL_CALL
  sender_code  text not null,
  sender_name  text,
  receiver_code text not null,
  room_name    text,
  is_video     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Receivers subscribe with a filter of `receiver_code=eq.<their cookie code>`, so this
-- index backs both the realtime filter and any cleanup queries.
create index if not exists call_signals_receiver_code_idx
  on public.call_signals (receiver_code, created_at desc);

-- Deliver INSERTs over Supabase Realtime (postgres_changes).
alter publication supabase_realtime add table public.call_signals;

-- NOTE: RLS is intentionally left permissive for now to match how `messages` and
-- `profiles` are accessed with the anon key today. The dedicated security pass (planned
-- separately) should enable RLS here and scope rows to the authenticated child.
alter table public.call_signals enable row level security;

drop policy if exists "call_signals anon full access (temporary)" on public.call_signals;
create policy "call_signals anon full access (temporary)"
  on public.call_signals
  for all
  using (true)
  with check (true);
