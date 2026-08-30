-- Reverts 20260829000000_drawing_sessions.sql — the collaborative "keep drawing" feature was
-- decided against after review (added meaningful schema/UI surface area for a narrow, oddly-
-- bounded interaction). Rather than rewriting the already-applied prior migration, this undoes
-- its effects explicitly so the history stays honest about what actually happened.

-- Restore the original, simpler insert policy (see 20260817000000_rls_lockdown.sql).
drop policy if exists "messages: send as myself" on public.messages;

create policy "messages: send as myself" on public.messages
  for insert with check (sender_code = public.my_cookie_code());

alter table public.messages
  drop column if exists drawing_session_id,
  drop column if exists drawing_session_created_at;

drop table if exists public.drawing_sessions;
