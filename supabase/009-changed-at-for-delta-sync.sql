-- ============================================================
--  009 — `changed_at`, so a phone can ask "what is new since…?"
--
--  The offline search snapshot pulls the whole table once and then only
--  the differences. That needs a single indexed column meaning "the last
--  time anything about this row changed" — an OR across entered_at and
--  updated_at cannot use an index, and would table-scan on every poll
--  from every search phone.
--
--  Adds a column and an index. Removes nothing. Safe to re-run.
-- ============================================================

alter table vehicles add column if not exists changed_at timestamptz;


-- --- Backfill -----------------------------------------------------------
-- The update trigger is switched off first, and this is not optional:
-- leaving it on would stamp updated_at = now() on all 1673 real entries
-- and mark every one of them as "edited" in the entry list.
alter table vehicles disable trigger vehicles_touch_updated_at;

update vehicles
set changed_at = greatest(entered_at, coalesce(updated_at, entered_at))
where changed_at is null;

alter table vehicles enable trigger vehicles_touch_updated_at;


-- --- Keep it current ----------------------------------------------------
create or replace function assign_entry_no()
returns trigger
language plpgsql
as $$
begin
  insert into block_counters (block_id, last_no)
  values (new.block_id, 1)
  on conflict (block_id)
  do update set last_no = block_counters.last_no + 1
  returning last_no into new.entry_no;

  -- A late sync carries the time the vehicle actually arrived, which can
  -- be an hour before it reached the server. The snapshot cursor has to
  -- move with the *write*, not with that, or a phone polling right now
  -- would step straight over this row and never see it.
  new.changed_at = now();
  return new;
end;
$$;

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.changed_at = now();
  return new;
end;
$$;


-- The delta query: rows with changed_at above the phone's cursor, oldest
-- first. Only ever a range scan over the tail of this index.
create index if not exists vehicles_changed_at_idx on vehicles (changed_at);


-- Deletions are pulled the same way, so a vehicle removed by the Super
-- Admin disappears from the phones too instead of lingering in the cache.
create index if not exists vehicle_deletions_deleted_at_idx
  on vehicle_deletions (deleted_at);


notify pgrst, 'reload schema';
