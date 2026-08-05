-- ============================================================
--  005 — One vehicle number, one mobile number, one entry.
--
--  Two admins at two different gates must not be able to enter the
--  same car, and the same mobile number must not come up twice.
--  The rule lives in the database, because that is the only place
--  both phones actually meet.
--
--  Safe to re-run. Paste into Supabase > SQL Editor and run.
-- ============================================================

-- --- 1. Refuse to run if the table already breaks the rule -------------
-- A unique index cannot be built over existing duplicates, and quietly
-- deleting somebody's entries is not this file's decision to make.
do $$
declare
  dup_reg   int;
  dup_phone int;
begin
  select count(*) into dup_reg from (
    select reg_no from vehicles
    where status = 'parked'
    group by reg_no having count(*) > 1
  ) t;

  select count(*) into dup_phone from (
    select owner_phone from vehicles
    where status = 'parked' and owner_phone is not null and owner_phone <> ''
    group by owner_phone having count(*) > 1
  ) t;

  if dup_reg > 0 or dup_phone > 0 then
    raise exception
      'Duplicates already in the table: % vehicle number(s), % mobile number(s). '
      'Run the two SELECTs at the bottom of this file to see them, delete the '
      'extra rows, then run this file again.', dup_reg, dup_phone;
  end if;
end $$;


-- --- 2. The rule ------------------------------------------------------
-- Scoped to status = 'parked'. Exit marking does not exist yet, so today
-- this covers every row; when a vehicle can be marked exited, the same
-- number becomes reusable without this file having to change.
create unique index if not exists vehicles_reg_no_unique
  on vehicles (reg_no)
  where status = 'parked';

-- Mobile is optional, so only rows that actually carry one are covered.
create unique index if not exists vehicles_phone_unique
  on vehicles (owner_phone)
  where status = 'parked' and owner_phone is not null and owner_phone <> '';


-- --- 3. If step 1 stopped you, these show what is in the way -----------
--
-- select reg_no, count(*), array_agg(reg_no_display), array_agg(id)
-- from vehicles where status = 'parked'
-- group by reg_no having count(*) > 1;
--
-- select owner_phone, count(*), array_agg(reg_no_display), array_agg(id)
-- from vehicles
-- where status = 'parked' and owner_phone is not null and owner_phone <> ''
-- group by owner_phone having count(*) > 1;
