-- ============================================================
--  Event Parking System — Database Schema
--  Paste this whole file into Supabase > SQL Editor and run it.
-- ============================================================

-- Needed for partial / fuzzy search (e.g. finding a plate from "1234")
create extension if not exists pg_trgm;


-- ============================================================
--  BLOCKS — created by the Super Admin
-- ============================================================
create table if not exists blocks (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,          -- "B-3"
  landmark     text,                          -- "Near Gate 2, opposite the blue tent"
  capacity     integer not null check (capacity > 0),
  vehicle_type text not null default 'car'
                 check (vehicle_type in ('car','bike','bus','mixed')),
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists blocks_active_idx on blocks (is_active, sort_order);


-- ============================================================
--  USER ACCOUNTS
--
--  One PIN per person, created by the Super Admin. A PIN identifies who
--  someone is and which block they may write to — the block is no longer
--  something the phone remembers and tells the server, which means the
--  server no longer has to take its word for it.
--
--  The Super Admin is deliberately NOT in this table. Their PIN lives in
--  the environment, so no row here can lock the one person who can
--  re-enable accounts out of the system.
-- ============================================================
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),

  -- Who this is, in words the Super Admin will recognise on the day:
  -- "Ramesh — P5 gate" beats a uuid when somebody rings up locked out.
  name          text not null,

  -- Digits only, stored as typed. Worth being clear why: a four-to-six
  -- digit PIN has at most a million values, so hashing buys almost
  -- nothing against anyone who can already reach this table — and only
  -- the server's secret key can. What it would cost is the thing that
  -- actually happens at an event: a volunteer forgets their PIN mid-rush
  -- and the Super Admin must read it back to them in five seconds.
  -- The real defence against guessing is login_attempts below.
  pin           text not null,

  role          text not null check (role in ('entry','search')),

  -- Which block this account may enter and correct. Exactly one, and
  -- only for entry accounts.
  block_id      uuid references blocks(id) on delete restrict,

  -- Turning this off stops the account on its next request, not at its
  -- next login: getSession() re-reads this row every time.
  is_active     boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  last_login_at timestamptz,

  -- An entry account is meaningless without a block, and a help-desk
  -- account must not carry one — it searches across all of them.
  constraint app_users_block_matches_role check (
    (role = 'entry'  and block_id is not null) or
    (role = 'search' and block_id is null)
  )
);

-- Two people must never share a PIN: login looks an account up *by* its
-- PIN, so a duplicate would silently hand one person the other's block.
create unique index if not exists app_users_pin_unique on app_users (pin);
create index if not exists app_users_active_idx on app_users (is_active, role);

create or replace function touch_app_users_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_users_touch on app_users;
create trigger app_users_touch
  before update on app_users
  for each row execute function touch_app_users_updated_at();


-- ============================================================
--  LOGIN THROTTLING
--  A six-digit PIN is a million guesses; unthrottled that is an
--  afternoon's work for a script. This is the actual protection on
--  every PIN in the system, including the Super Admin's. Per IP,
--  because an attacker guessing PINs just tries the next one.
-- ============================================================
create table if not exists login_attempts (
  id        bigserial primary key,
  ip        text not null,
  succeeded boolean not null,
  at        timestamptz not null default now()
);

create index if not exists login_attempts_ip_at_idx on login_attempts (ip, at desc);

create or replace function prune_login_attempts()
returns void
language sql
as $$
  delete from login_attempts where at < now() - interval '1 day';
$$;


-- ============================================================
--  VEHICLES — entered by the block admins
-- ============================================================
create table if not exists vehicles (
  id             uuid primary key default gen_random_uuid(),

  -- 1, 2, 3… within the block. Assigned by the database, never by the
  -- phone — two phones on one block would otherwise both claim the
  -- same number. See block_counters below.
  entry_no       integer,

  -- Normalized: A-Z and 0-9 only, uppercase. All search runs against this.
  reg_no         text not null,
  -- As the admin typed it (for display)
  reg_no_display text not null,

  block_id       uuid not null references blocks(id) on delete restrict,

  owner_name     text,
  owner_phone    text,

  -- Optional. Lets the help desk find a vehicle when the visitor knows
  -- where they came from but not the number they arrived in.
  village        text,
  taluka         text,

  -- Where inside the block this one is standing — "near light tower 4".
  -- The block's own landmark says where the block is; this says where the
  -- car is, which is what the visitor actually needs at exit time.
  landmark       text,

  -- Car, bike, tractor… Optional, and free text on purpose: blocks carry a
  -- checked vehicle_type because the Super Admin sets a handful of them by
  -- hand, but this one is typed at the gate a hundred thousand times and
  -- will meet vehicles nobody listed in advance. A refused entry with a
  -- car waiting is worse than a spelling tidied up afterwards — and
  -- entry_suggestions() keeps the spellings together anyway.
  vehicle_type   text,

  status         text not null default 'parked'
                   check (status in ('parked','exited')),

  entered_at     timestamptz not null default now(),
  exited_at      timestamptz,

  -- Offline sync: the id the entry was given on the device.
  -- A resend over a flaky network will not create a duplicate.
  client_uuid    text unique,
  device_id      text,

  -- Which account made this entry. Half of "who put this in?" — device_id
  -- is the other half, saying which phone. Null for entries made before
  -- accounts existed. Set null on delete, not restrict: removing a
  -- volunteer's account months later must not be blocked by the entries
  -- they made, and must certainly not take those entries with it.
  user_id        uuid references app_users(id) on delete set null,

  created_at     timestamptz not null default now(),
  -- Null until somebody edits the row. "Never edited" and "edited the
  -- instant it was created" are different facts, so no default.
  updated_at     timestamptz,

  -- The last time anything about this row changed, set by trigger on both
  -- insert and update. The offline search snapshot pages through this: an
  -- OR across entered_at and updated_at cannot use an index, and would
  -- table-scan on every poll from every search phone.
  changed_at     timestamptz
);

-- --- Uniqueness -------------------------------------------------------
-- The same car, and the same mobile number, must not be entered twice —
-- not even from two different phones at two different gates. Scoped to
-- 'parked' so the number frees up if exit marking is added later.
create unique index if not exists vehicles_reg_no_unique
  on vehicles (reg_no)
  where status = 'parked';
create unique index if not exists vehicles_phone_unique
  on vehicles (owner_phone)
  where status = 'parked' and owner_phone is not null and owner_phone <> '';

-- --- Search indexes ---------------------------------------------------
-- Exact plate (the fastest path)
create index if not exists vehicles_reg_no_idx      on vehicles (reg_no);
-- Partial plate — "1234" alone still works
create index if not exists vehicles_reg_trgm_idx    on vehicles using gin (reg_no gin_trgm_ops);
-- Phone search, including just the last 4 digits
create index if not exists vehicles_phone_trgm_idx  on vehicles using gin (owner_phone gin_trgm_ops);
-- Name search, tolerant of spelling differences
create index if not exists vehicles_name_trgm_idx   on vehicles using gin (owner_name gin_trgm_ops);
-- Village / taluka — searched case-insensitively, hence lower(...)
create index if not exists vehicles_village_trgm_idx on vehicles using gin (lower(village) gin_trgm_ops);
create index if not exists vehicles_taluka_trgm_idx  on vehicles using gin (lower(taluka) gin_trgm_ops);
create index if not exists vehicles_village_lower_idx on vehicles (lower(village));
create index if not exists vehicles_taluka_lower_idx  on vehicles (lower(taluka));
-- Landmark, searched the same tolerant way village is
create index if not exists vehicles_landmark_trgm_idx on vehicles using gin (lower(landmark) gin_trgm_ops);
-- Vehicle type — grouped case-insensitively by entry_suggestions()
create index if not exists vehicles_vehicle_type_lower_idx on vehicles (lower(vehicle_type));
-- Live dashboard counts
create index if not exists vehicles_block_parked_idx on vehicles (block_id) where status = 'parked';
create index if not exists vehicles_entered_at_idx   on vehicles (entered_at desc);


-- ============================================================
--  ENTRY NUMBERS — 1, 2, 3… inside each block
--
--  One counter row per block. Taking a number is a single UPDATE, so
--  two phones saving in the same instant queue on the row instead of
--  both reading the same maximum and colliding.
-- ============================================================
create table if not exists block_counters (
  block_id uuid primary key references blocks(id) on delete cascade,
  last_no  integer not null default 0
);

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

drop trigger if exists vehicles_assign_entry_no on vehicles;
create trigger vehicles_assign_entry_no
  before insert on vehicles
  for each row execute function assign_entry_no();

-- Two entries in one block must never share a number
create unique index if not exists vehicles_block_entry_no_idx on vehicles (block_id, entry_no);
-- The block-wise entry list reads in this order
create index if not exists vehicles_block_entry_desc_idx on vehicles (block_id, entry_no desc);
-- Searching "#42" across every block
create index if not exists vehicles_entry_no_idx on vehicles (entry_no);
-- "What did this person enter?"
create index if not exists vehicles_user_id_idx on vehicles (user_id);


-- Stamp an edit, so "this was corrected later" is visible
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

drop trigger if exists vehicles_touch_updated_at on vehicles;
create trigger vehicles_touch_updated_at
  before update on vehicles
  for each row execute function touch_updated_at();

-- The offline snapshot's delta query: rows above the phone's cursor,
-- oldest first. Only ever a range scan over the tail of this index.
create index if not exists vehicles_changed_at_idx on vehicles (changed_at);


-- ============================================================
--  DELETING KEEPS THE ROW
--  A delete on the day is almost always a correction, and occasionally
--  a mistake. The whole row is copied here first, so "we deleted the
--  wrong one" has an answer instead of a shrug.
-- ============================================================
create table if not exists vehicle_deletions (
  id         uuid primary key default gen_random_uuid(),
  vehicle    jsonb not null,
  block_name text,
  deleted_at timestamptz not null default now(),
  reason     text
);

create index if not exists vehicle_deletions_at_idx on vehicle_deletions (deleted_at desc);
-- Ascending too: the snapshot pulls deletions forward from a cursor, so a
-- vehicle the Super Admin removed disappears from the phones as well
-- instead of lingering in their caches.
create index if not exists vehicle_deletions_deleted_at_idx on vehicle_deletions (deleted_at);

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


-- ============================================================
--  RESETS — a record of every "Start Fresh"
--  Doubles as the data epoch the phones compare against, so they
--  clear their own offline queue when the table is wiped.
-- ============================================================
create table if not exists resets (
  id               uuid primary key default gen_random_uuid(),
  performed_at     timestamptz not null default now(),
  vehicles_deleted integer not null default 0
);

create index if not exists resets_performed_at_idx on resets (performed_at desc);

-- One statement, so it cannot half-happen. Blocks are deliberately
-- untouched — they are the setup, not the data.
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

  -- Practice deletions are practice data too
  delete from vehicle_deletions where id is not null;

  -- Numbering starts again at 1 in every block. Without this the next
  -- entry after a reset would be number 348, not 1.
  update block_counters set last_no = 0 where block_id is not null;

  insert into resets (vehicles_deleted)
  values (removed)
  returning resets.performed_at into stamp;

  vehicles_deleted := removed;
  performed_at := stamp;
  return next;
end;
$$;

create or replace function data_epoch()
returns timestamptz
language sql
stable
as $$
  select max(performed_at) from resets;
$$;


-- ============================================================
--  DASHBOARD VIEW — live status per block
-- ============================================================
create or replace view block_status as
select
  b.id,
  b.name,
  b.landmark,
  b.capacity,
  b.vehicle_type,
  b.sort_order,
  b.is_active,
  coalesce(v.parked, 0)                          as parked,
  b.capacity - coalesce(v.parked, 0)             as remaining,
  round(coalesce(v.parked, 0) * 100.0 / b.capacity, 1) as fill_percent
from blocks b
left join (
  select block_id, count(*) as parked
  from vehicles
  where status = 'parked'
  group by block_id
) v on v.block_id = b.id;


-- ============================================================
--  SEARCH FUNCTION — number / phone / name in one box, with
--  village and taluka as optional narrowing filters.
--
--  Any combination works:
--    village only            → every vehicle from that village + its block
--    village + taluka        → only the vehicles matching both
--    number + village        → narrowed further still
--  The more fields are filled in, the smaller the answer gets.
-- ============================================================
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
      else 10                                                             -- partial village/taluka
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
  limit 200;   -- a whole village can be dozens of vehicles, not just a few
$$;


-- ============================================================
--  entry_suggestions()
--
--  Everything anybody has already typed into village, taluka, landmark or
--  vehicle type, most-used first. The entry screen offers it back, so a
--  village is spelled out in full by the first person to meet it and
--  tapped by everybody after them — which is most of the typing on the
--  screen, and all of it done one-handed on a phone.
--
--    field  — 'village' | 'taluka' | 'landmark' | 'vehicle_type'
--    value  — the spelling to offer back
--    pair   — for a village, the taluka it usually belongs to
--    uses   — how many entries carry it
-- ============================================================
-- Short column names inside, and every reference qualified. `returns
-- table` makes field/value/pair/uses into output parameters, and a bare
-- `value` in the body would then be two things at once.
create or replace function entry_suggestions()
returns table (field text, value text, pair text, uses bigint)
language sql
stable
as $$
  with vals as (
    select 'village'::text          as f,
           trim(x.village)          as v,
           nullif(trim(x.taluka), '') as p
      from vehicles x
     where coalesce(trim(x.village), '') <> ''
    union all
    select 'taluka', trim(x.taluka), null
      from vehicles x
     where coalesce(trim(x.taluka), '') <> ''
    union all
    select 'landmark', trim(x.landmark), null
      from vehicles x
     where coalesce(trim(x.landmark), '') <> ''
    union all
    select 'vehicle_type', trim(x.vehicle_type), null
      from vehicles x
     where coalesce(trim(x.vehicle_type), '') <> ''
  ),
  -- Counted per exact spelling first, so the variant offered back is the
  -- one most people actually typed...
  exact as (
    select s.f, s.v, count(*) as n from vals s group by s.f, s.v
  ),
  -- ...then collapsed case-insensitively, so "Savli" and "savli" are one
  -- suggestion carrying both counts rather than two half-used ones. The
  -- cast is load-bearing: sum() over bigint returns numeric, and the
  -- declared return type is not.
  grouped as (
    select e.f, lower(e.v) as k, sum(e.n)::bigint as n from exact e group by e.f, lower(e.v)
  ),
  -- Which spelling to offer back: use decides, and on a tie the
  -- capitalised form wins. Every value is tied on the first morning, and
  -- "car" sitting next to "Bike" reads as a bug in the app.
  best as (
    select distinct on (e.f, lower(e.v)) e.f, lower(e.v) as k, e.v
      from exact e
     order by e.f, lower(e.v), e.n desc, (left(e.v, 1) = upper(left(e.v, 1))) desc, e.v
  ),
  pair_counts as (
    select lower(s.v) as k, s.p, count(*) as n
      from vals s
     where s.f = 'village' and s.p is not null
     group by lower(s.v), s.p
  ),
  best_pair as (
    select distinct on (c.k) c.k, c.p from pair_counts c order by c.k, c.n desc, c.p
  ),
  -- Capped per field, not overall: one limit on the end would silently
  -- drop whichever field happened to sort last.
  ranked as (
    select g.f, b.v, bp.p, g.n,
           row_number() over (partition by g.f order by g.n desc, b.v) as rn
      from grouped g
      join best b            on b.f = g.f and b.k = g.k
      left join best_pair bp on g.f = 'village' and bp.k = g.k
  )
  select r.f, r.v, r.p, r.n
    from ranked r
   where r.rn <= 500
   order by r.f, r.n desc, r.v;
$$;


-- Villages already entered. Superseded by entry_suggestions() above, which
-- covers all four suggested fields and orders them by use. Left in place
-- rather than dropped: nothing reads it any more, and a drop is the one
-- change here that could not be undone by re-running this file.
create or replace function village_suggestions()
returns table (village text, taluka text)
language sql
stable
as $$
  select distinct on (lower(v.village), lower(coalesce(v.taluka, '')))
         v.village, v.taluka
  from vehicles v
  where v.village is not null and v.village <> ''
  order by lower(v.village), lower(coalesce(v.taluka, '')), v.entered_at desc
  limit 500;
$$;


-- ============================================================
--  ROW LEVEL SECURITY
--  Everything goes through the server using the secret key.
--  The browser's publishable key can reach no data directly.
-- ============================================================
alter table blocks   enable row level security;
alter table vehicles enable row level security;

-- No anon/publishable policy is created — this is deliberate. The table
-- holds names and mobile numbers for tens of thousands of people, and
-- there should be no path to read that straight from a browser.

-- --- GRANTS ----------------------------------------------------------
-- "Automatically expose new tables" is off, so new tables start with no
-- role permissions. Only service_role is granted access — that role is
-- held by the server's secret key, never by the browser.
grant usage on schema public to service_role;

grant select, insert, update, delete on blocks            to service_role;
grant select, insert, update, delete on vehicles          to service_role;
grant select, insert, update, delete on app_users         to service_role;
grant select, insert, delete         on login_attempts    to service_role;
grant usage, select on sequence login_attempts_id_seq     to service_role;
grant execute on function prune_login_attempts()          to service_role;
grant select, insert, update, delete on block_counters    to service_role;
grant select, insert, delete         on vehicle_deletions to service_role;
grant select                         on block_status      to service_role;
grant select, insert                 on resets            to service_role;
grant execute on function reset_all_data()                  to service_role;
grant execute on function data_epoch()                      to service_role;
grant execute on function search_vehicles(text, text, text) to service_role;
grant execute on function village_suggestions()             to service_role;
grant execute on function entry_suggestions()               to service_role;
grant execute on function delete_vehicle(uuid, text)        to service_role;

alter table block_counters    enable row level security;
alter table vehicle_deletions enable row level security;
alter table app_users         enable row level security;
alter table login_attempts    enable row level security;

-- No anon policy anywhere near app_users. It holds every PIN in the
-- system; there must be no path to it from a browser.
revoke all on app_users         from anon, authenticated;
revoke all on login_attempts    from anon, authenticated;
revoke all on blocks            from anon, authenticated;
revoke all on vehicles          from anon, authenticated;
revoke all on block_counters    from anon, authenticated;
revoke all on vehicle_deletions from anon, authenticated;
revoke all on block_status      from anon, authenticated;
revoke all on resets            from anon, authenticated;


-- ============================================================
--  Sample blocks for testing.
--  Create the real blocks from the /admin/blocks screen, and run
--  003-clear-test-data.sql before the event to remove these.
-- ============================================================
insert into blocks (name, landmark, capacity, vehicle_type, sort_order) values
  ('A-1', 'Near the Main Gate',            500, 'car',  1),
  ('A-2', 'Straight ahead from Main Gate', 500, 'car',  2),
  ('B-1', 'Gate 2, by the blue tent',      300, 'bike', 3)
on conflict (name) do nothing;
