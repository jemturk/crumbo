-- Real bug: a call's two participants each independently run their own ~45s ring-timeout and
-- write their own [CALL_LOG:...] row for the same call (necessary — a backgrounded/killed
-- receiver's only sync mechanism is a push notification that can silently fail to arrive, so
-- neither side can safely rely on the other to log the call). Both rows sync to both devices via
-- the shared `messages` table. Client code has always had to remember to collapse them back down
-- by the callUUID embedded in the row's `text` (dedupeCallLogs in storage.ts) — and one real
-- reader (getChatLogsForParent, the parent's chat view) never did, so parents saw every call
-- logged twice while kids only ever saw one. That's a bug class (any future reader can forget the
-- same step), not a one-off, since nothing actually stops two rows existing.
--
-- Fixes it at the source: give call-log rows a real `call_uuid` column (extracted from the same
-- text format dedupeCallLogs already parses) with a uniqueness constraint, so only one row can
-- ever physically exist per call — whichever side's insert lands first wins, the second is a
-- no-op. No reader needs to know this history exists at all going forward.

alter table public.messages add column call_uuid text;

-- Backfill from existing rows' embedded text so historical calls dedupe too. Mirrors
-- extractCallLogUUID's own logic in storage.ts: strip the '[CALL_LOG:' prefix and trailing ']',
-- take the 3rd colon-delimited field, and only accept it if it contains a hyphen (a real UUID) —
-- a brief prior text format instead had a plain duration-in-seconds integer in this position for
-- ended calls, which must never be mistaken for a callUUID.
update public.messages
set call_uuid = split_part(replace(replace(text, '[CALL_LOG:', ''), ']', ''), ':', 3)
where text like '[CALL_LOG:%'
  and call_uuid is null
  and split_part(replace(replace(text, '[CALL_LOG:', ''), ']', ''), ':', 3) like '%-%';

-- Collapse any already-existing duplicate pairs before the constraint can be added, keeping
-- whichever row has the lexicographically smaller id — same deterministic tiebreak dedupeCallLogs
-- already uses client-side, so this converges on the same row a client would have picked anyway.
with ranked as (
  select id, row_number() over (partition by call_uuid order by id) as rn
  from public.messages
  where call_uuid is not null
)
delete from public.messages
where id in (select id from ranked where rn > 1);

-- Nullable column: Postgres treats every NULL as distinct under a unique constraint, so ordinary
-- (non-call-log) messages, which always get call_uuid = null, are entirely unaffected.
alter table public.messages add constraint messages_call_uuid_unique unique (call_uuid);
