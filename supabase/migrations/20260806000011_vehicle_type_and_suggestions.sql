-- ============================================================
--  011 — Vehicle type on the entry, and one suggestion source
--        for every free-text field
--
--  Two things:
--    1. vehicles.vehicle_type — optional, free text. Deliberately not a
--       check constraint like blocks.vehicle_type has: a block is created
--       once by the Super Admin, but this is typed a hundred thousand
--       times by volunteers who will meet tractors, tempos and things
--       nobody listed in advance. A refused entry at the gate is worse
--       than a spelling that needs tidying afterwards.
--    2. entry_suggestions() — every value anybody has already entered for
--       village, taluka, landmark or vehicle type, most-used first. The
--       entry screen offers them back, so "Savli" is typed once by the
--       first person and tapped by everybody after them.
--
--  Replaces village_suggestions(), which only covered two of the four.
--  The old function is left in place — dropping it would break any phone
--  still running the previous build during the rollout.
-- ============================================================

alter table vehicles add column if not exists vehicle_type text;

-- Suggestions group case-insensitively, and the export reads it raw
create index if not exists vehicles_vehicle_type_lower_idx
  on vehicles (lower(vehicle_type));


-- ============================================================
--  entry_suggestions()
--
--    field  — 'village' | 'taluka' | 'landmark' | 'vehicle_type'
--    value  — the spelling to offer back
--    pair   — for a village, the taluka it usually belongs to, so
--             choosing the village fills the taluka in as well
--    uses   — how many entries carry it; the phone sorts on this, and
--             the commonest few are shown before a single key is pressed
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
    select s.f, s.v, count(*) as n
      from vals s
     group by s.f, s.v
  ),

  -- ...and then collapsed case-insensitively, so "Savli" and "savli" come
  -- back as one suggestion carrying both counts, rather than two half-used
  -- ones fighting for the same place in the list.
  -- sum() over bigint returns numeric, and the declared return type is not
  -- — without the cast the function fails at run time, not at create time.
  grouped as (
    select e.f, lower(e.v) as k, sum(e.n)::bigint as n
      from exact e
     group by e.f, lower(e.v)
  ),

  -- Which spelling of the value to offer back. Use decides it; on a tie —
  -- which is every value on the first morning, when each has been entered
  -- exactly once — the capitalised form wins. These are village and taluka
  -- names, and "car" offered next to "Bike" looks like a mistake in the app.
  best as (
    select distinct on (e.f, lower(e.v)) e.f, lower(e.v) as k, e.v
      from exact e
     order by e.f, lower(e.v), e.n desc, (left(e.v, 1) = upper(left(e.v, 1))) desc, e.v
  ),

  -- The taluka a village is most often entered with
  pair_counts as (
    select lower(s.v) as k, s.p, count(*) as n
      from vals s
     where s.f = 'village' and s.p is not null
     group by lower(s.v), s.p
  ),

  best_pair as (
    select distinct on (c.k) c.k, c.p
      from pair_counts c
     order by c.k, c.n desc, c.p
  ),

  -- Capped per field, not overall. One long list with a single limit on
  -- the end would silently drop whichever field happened to sort last.
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

grant execute on function entry_suggestions() to service_role;


-- PostgREST caches the schema. Without this the new column and function
-- are invisible until the connection pool happens to turn over.
notify pgrst, 'reload schema';
