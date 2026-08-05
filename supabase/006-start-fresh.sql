-- ============================================================
--  006 — "Start Fresh": clear every entry and begin again.
--
--  After a day of trial runs the table is full of practice entries.
--  This lets the Super Admin wipe them from the phone, without
--  anyone opening a SQL editor on the day of the event.
--
--  Blocks are NOT touched. They are the setup, not the data —
--  losing them mid-event would be far worse than keeping a few
--  practice entries.
--
--  Safe to re-run. Paste into Supabase > SQL Editor and run.
-- ============================================================

-- --- 1. A record of every reset -----------------------------------------
-- Doubles as the "data epoch": the phones compare the newest reset
-- against the last one they saw, and clear their own offline queue when
-- it changes. Without that, a phone would keep refusing numbers it
-- remembers entering, and would re-sync entries that were just cleared.
create table if not exists resets (
  id               uuid primary key default gen_random_uuid(),
  performed_at     timestamptz not null default now(),
  vehicles_deleted integer not null default 0
);

create index if not exists resets_performed_at_idx on resets (performed_at desc);


-- --- 2. The reset itself ------------------------------------------------
-- One statement, so it cannot half-happen: either the entries are gone
-- and the reset is logged, or nothing changed at all.
create or replace function reset_all_data()
returns table (vehicles_deleted integer, performed_at timestamptz)
language plpgsql
as $$
declare
  removed integer;
  stamp   timestamptz;
begin
  -- The WHERE clause is required, not decorative: Supabase runs the API
  -- role with safeupdate, which refuses a DELETE that has no WHERE.
  -- id is the primary key, so this still matches every row.
  delete from vehicles where id is not null;
  get diagnostics removed = row_count;

  insert into resets (vehicles_deleted)
  values (removed)
  returning resets.performed_at into stamp;

  vehicles_deleted := removed;
  performed_at := stamp;
  return next;
end;
$$;


-- --- 3. What the phones read to notice a reset --------------------------
create or replace function data_epoch()
returns timestamptz
language sql
stable
as $$
  select max(performed_at) from resets;
$$;


grant select, insert on resets              to service_role;
grant execute on function reset_all_data()  to service_role;
grant execute on function data_epoch()      to service_role;

revoke all on resets from anon, authenticated;
