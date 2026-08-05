-- ============================================================
--  008 — What the field trial asked for
--
--    1. Entry numbers — 1, 2, 3… inside each block
--    2. Landmark on the entry itself ("near light tower 4")
--    3. Edit an entry, and delete it (with the row kept, not lost)
--    4. Search by entry number
--
--  NOTHING HERE REMOVES DATA. Existing entries keep every value they
--  have; they only gain an entry number, filled in the order they
--  actually arrived. Safe to run on the live table, and safe to re-run.
-- ============================================================


-- --- 1. New columns -----------------------------------------------------
alter table vehicles add column if not exists entry_no   integer;
alter table vehicles add column if not exists landmark   text;
-- Null until somebody edits the row. "Never edited" and "edited at the
-- moment it was created" are different facts, so this does not default
-- to now() the way created_at does.
alter table vehicles add column if not exists updated_at timestamptz;


-- --- 2. The counter behind the numbering --------------------------------
-- One row per block, holding the last number handed out. Taking a number
-- is a single UPDATE, so two phones saving in the same instant queue on
-- the row rather than both reading the same maximum and colliding.
create table if not exists block_counters (
  block_id uuid primary key references blocks(id) on delete cascade,
  last_no  integer not null default 0
);


-- --- 3. Number the entries that already exist ---------------------------
-- In arrival order, per block, so entry 1 in a block really is the first
-- vehicle that block admitted. Rows that already carry a number are left
-- alone, which is what makes this safe to run twice.
with base as (
  select block_id, coalesce(max(entry_no), 0) as start_no
  from vehicles
  group by block_id
),
numbered as (
  select
    v.id,
    b.start_no + row_number() over (
      partition by v.block_id
      order by v.entered_at, v.created_at, v.id
    ) as n
  from vehicles v
  join base b on b.block_id = v.block_id
  where v.entry_no is null
)
update vehicles v
set entry_no = numbered.n
from numbered
where numbered.id = v.id;

-- Start each counter above whatever the backfill used
insert into block_counters (block_id, last_no)
select block_id, max(entry_no) from vehicles group by block_id
on conflict (block_id)
do update set last_no = greatest(block_counters.last_no, excluded.last_no);


-- --- 4. Hand out the number on every new entry --------------------------
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
  return new;
end;
$$;

drop trigger if exists vehicles_assign_entry_no on vehicles;
create trigger vehicles_assign_entry_no
  before insert on vehicles
  for each row execute function assign_entry_no();

-- Two entries in one block must never share a number.
create unique index if not exists vehicles_block_entry_no_idx
  on vehicles (block_id, entry_no);

-- The block-wise entry list reads in this exact order
create index if not exists vehicles_block_entry_desc_idx
  on vehicles (block_id, entry_no desc);
-- Searching "#42" across every block
create index if not exists vehicles_entry_no_idx on vehicles (entry_no);
-- Landmark, searched the same tolerant way village already is
create index if not exists vehicles_landmark_trgm_idx
  on vehicles using gin (lower(landmark) gin_trgm_ops);


-- --- 5. Stamp an edit ----------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vehicles_touch_updated_at on vehicles;
create trigger vehicles_touch_updated_at
  before update on vehicles
  for each row execute function touch_updated_at();


-- --- 6. Deleting keeps the row ------------------------------------------
-- A delete on the day of the event is almost always a correction, and
-- occasionally a mistake. The whole row is copied here first, so "we
-- deleted the wrong one" has an answer instead of a shrug.
create table if not exists vehicle_deletions (
  id         uuid primary key default gen_random_uuid(),
  vehicle    jsonb not null,
  block_name text,
  deleted_at timestamptz not null default now(),
  reason     text
);

create index if not exists vehicle_deletions_at_idx on vehicle_deletions (deleted_at desc);

-- Archive and delete in one statement, so the row can never be gone
-- without a copy of it existing.
create or replace function delete_vehicle(p_id uuid, p_reason text default null)
returns table (deleted boolean, reg_no_display text)
language plpgsql
as $$
declare
  v record;
  bname text;
begin
  select * into v from vehicles where id = p_id;
  if not found then
    deleted := false;
    reg_no_display := null;
    return next;
    return;
  end if;

  select name into bname from blocks where id = v.block_id;

  insert into vehicle_deletions (vehicle, block_name, reason)
  values (to_jsonb(v), bname, p_reason);

  delete from vehicles where id = p_id;

  deleted := true;
  reg_no_display := v.reg_no_display;
  return next;
end;
$$;


-- --- 7. "Start Fresh" also restarts the numbering -----------------------
-- Without this the next practice entry would be number 348, not 1.
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
  delete from vehicles where id is not null;
  get diagnostics removed = row_count;

  -- Practice deletions are practice data too
  delete from vehicle_deletions where id is not null;

  -- Numbering starts again at 1 in every block
  update block_counters set last_no = 0 where block_id is not null;

  insert into resets (vehicles_deleted)
  values (removed)
  returning resets.performed_at into stamp;

  vehicles_deleted := removed;
  performed_at := stamp;
  return next;
end;
$$;


-- --- 8. Search: entry number, and the landmark in the answer ------------
-- The signature is unchanged, so a deploy in either order keeps working:
-- the extra columns are simply ignored by code that does not know them.
drop function if exists search_vehicles(text);
drop function if exists search_vehicles(text, text, text);

create function search_vehicles(q text, village_q text, taluka_q text)
returns table (
  id             uuid,
  entry_no       integer,
  reg_no_display text,
  owner_name     text,
  owner_phone    text,
  village        text,
  taluka         text,
  landmark       text,
  entered_at     timestamptz,
  status         text,
  block_id       uuid,
  block_name     text,
  block_landmark text,
  match_rank     int
)
language sql
stable
as $$
  with cleaned as (
    select
      upper(regexp_replace(coalesce(q, ''), '[^a-zA-Z0-9]', '', 'g')) as reg_q,
      regexp_replace(coalesce(q, ''), '[^0-9]', '', 'g')              as phone_q,
      lower(trim(coalesce(q, '')))                                    as name_q,
      lower(trim(coalesce(village_q, '')))                            as vill_q,
      lower(trim(coalesce(taluka_q, '')))                             as tal_q,
      -- Plain digits are tried as an entry number *as well as* a plate or
      -- phone fragment — "42" could be either, and the operator should not
      -- have to decide. A leading # means they are certain, and then
      -- nothing else is searched.
      case
        when trim(coalesce(q, '')) ~ '^#?\s*[0-9]{1,6}$'
        then (regexp_replace(coalesce(q, ''), '[^0-9]', '', 'g'))::int
      end                                                             as entry_q,
      (trim(coalesce(q, '')) ~ '^#')                                  as entry_only
  )
  select
    v.id,
    v.entry_no,
    v.reg_no_display,
    v.owner_name,
    v.owner_phone,
    v.village,
    v.taluka,
    v.landmark,
    v.entered_at,
    v.status,
    b.id,
    b.name,
    b.landmark,
    case
      when c.entry_q is not null and v.entry_no = c.entry_q                then 1
      when c.reg_q   <> '' and v.reg_no = c.reg_q                          then 2  -- exact plate
      when c.reg_q   <> '' and v.reg_no like '%' || c.reg_q                then 3  -- ends with
      when c.reg_q   <> '' and v.reg_no like '%' || c.reg_q || '%'         then 4  -- contains
      when c.phone_q <> '' and v.owner_phone like '%' || c.phone_q || '%'  then 5
      when c.name_q  <> '' and v.owner_name ilike '%' || c.name_q || '%'   then 6
      when c.vill_q <> '' and lower(v.village) = c.vill_q
           and c.tal_q <> '' and lower(v.taluka) = c.tal_q                 then 7  -- both exact
      when c.vill_q <> '' and lower(v.village) = c.vill_q                  then 8
      when c.tal_q  <> '' and lower(v.taluka)  = c.tal_q                   then 9
      else 10                                                              -- partial village/taluka
    end as match_rank
  from vehicles v
  join blocks b on b.id = v.block_id
  cross join cleaned c
  where
    -- At least one field must carry something, or nothing is returned
    (c.name_q <> '' or c.vill_q <> '' or c.tal_q <> '')

    -- A blank q means "do not filter on the vehicle number at all"
    and (
      c.name_q = ''
      or (c.entry_only and v.entry_no = c.entry_q)
      or (not c.entry_only and (
            (c.entry_q is not null and v.entry_no = c.entry_q)
         or (length(c.reg_q)   >= 3 and v.reg_no      like  '%' || c.reg_q   || '%')
         or (length(c.phone_q) >= 4 and v.owner_phone like  '%' || c.phone_q || '%')
         or (length(c.name_q)  >= 3 and v.owner_name  ilike '%' || c.name_q  || '%')
      ))
    )

    -- Each of these is optional; giving both means matching both
    and (c.vill_q = '' or lower(v.village) like '%' || c.vill_q || '%')
    and (c.tal_q  = '' or lower(v.taluka)  like '%' || c.tal_q  || '%')

  order by match_rank, b.name, v.entered_at desc
  limit 200;
$$;


-- --- 9. Permissions ------------------------------------------------------
grant select, insert, update, delete on vehicles          to service_role;
grant select, insert, update, delete on block_counters    to service_role;
grant select, insert, delete         on vehicle_deletions to service_role;
grant execute on function search_vehicles(text, text, text) to service_role;
grant execute on function delete_vehicle(uuid, text)        to service_role;
grant execute on function reset_all_data()                  to service_role;

alter table block_counters    enable row level security;
alter table vehicle_deletions enable row level security;
revoke all on block_counters    from anon, authenticated;
revoke all on vehicle_deletions from anon, authenticated;


-- --- 10. Tell the API about the new columns -----------------------------
-- Supabase usually picks this up on its own within a minute. Saying it
-- explicitly means entry_no and landmark work the second this finishes,
-- instead of the app 404-ing on them in between.
notify pgrst, 'reload schema';
