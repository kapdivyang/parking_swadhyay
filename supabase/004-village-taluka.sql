-- ============================================================
--  004 — Village + Taluka on every vehicle, and a search that
--        can filter on either one, both, or neither.
--
--  Safe to re-run. Paste into Supabase > SQL Editor and run.
--  (schema.sql already carries these changes for a fresh setup.)
-- ============================================================

-- --- 1. The two new optional fields -----------------------------------
alter table vehicles add column if not exists village text;
alter table vehicles add column if not exists taluka  text;

-- Searched case-insensitively, so the indexes are on lower(...)
create index if not exists vehicles_village_trgm_idx
  on vehicles using gin (lower(village) gin_trgm_ops);
create index if not exists vehicles_taluka_trgm_idx
  on vehicles using gin (lower(taluka) gin_trgm_ops);

-- "Every vehicle from this village" is a whole-village listing, so the
-- exact-match path gets a plain btree index of its own.
create index if not exists vehicles_village_lower_idx on vehicles (lower(village));
create index if not exists vehicles_taluka_lower_idx  on vehicles (lower(taluka));


-- --- 2. Replace the search function ------------------------------------
-- The old one took a single argument. It is dropped rather than kept
-- alongside, so there is no ambiguity about which one a call resolves to.
drop function if exists search_vehicles(text);
drop function if exists search_vehicles(text, text, text);

create function search_vehicles(q text, village_q text, taluka_q text)
returns table (
  id             uuid,
  reg_no_display text,
  owner_name     text,
  owner_phone    text,
  village        text,
  taluka         text,
  entered_at     timestamptz,
  status         text,
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
      lower(trim(coalesce(taluka_q, '')))                             as tal_q
  )
  select
    v.id,
    v.reg_no_display,
    v.owner_name,
    v.owner_phone,
    v.village,
    v.taluka,
    v.entered_at,
    v.status,
    b.name,
    b.landmark,
    case
      -- Vehicle number / phone / name — the strongest signals first
      when c.reg_q   <> '' and v.reg_no = c.reg_q                          then 1
      when c.reg_q   <> '' and v.reg_no like '%' || c.reg_q                then 2
      when c.reg_q   <> '' and v.reg_no like '%' || c.reg_q || '%'         then 3
      when c.phone_q <> '' and v.owner_phone like '%' || c.phone_q || '%'  then 4
      when c.name_q  <> '' and v.owner_name ilike '%' || c.name_q || '%'   then 5
      -- No vehicle number given: village + taluka both exact is the best hit
      when c.vill_q <> '' and lower(v.village) = c.vill_q
           and c.tal_q <> '' and lower(v.taluka) = c.tal_q                 then 6
      when c.vill_q <> '' and lower(v.village) = c.vill_q                  then 7
      when c.tal_q  <> '' and lower(v.taluka)  = c.tal_q                   then 8
      else 9                                                              -- partial village/taluka
    end as match_rank
  from vehicles v
  join blocks b on b.id = v.block_id
  cross join cleaned c
  where
    -- At least one field must carry something, or nothing is returned
    (c.name_q <> '' or c.vill_q <> '' or c.tal_q <> '')

    -- Blank q means "do not filter on the vehicle number at all"
    and (
      c.name_q = ''
      or (length(c.reg_q)   >= 3 and v.reg_no      like  '%' || c.reg_q   || '%')
      or (length(c.phone_q) >= 4 and v.owner_phone like  '%' || c.phone_q || '%')
      or (length(c.name_q)  >= 3 and v.owner_name  ilike '%' || c.name_q  || '%')
    )

    -- Village and taluka narrow the result down; each is optional, and
    -- giving both means the vehicle has to match both.
    and (c.vill_q = '' or lower(v.village) like '%' || c.vill_q || '%')
    and (c.tal_q  = '' or lower(v.taluka)  like '%' || c.tal_q  || '%')

  order by match_rank, b.name, v.entered_at desc
  limit 200;   -- a whole village can be dozens of vehicles, not just a few
$$;

grant execute on function search_vehicles(text, text, text) to service_role;


-- --- 3. Distinct villages already entered, for the entry form's
--        suggestion list. Keeps spellings consistent across devices.
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

grant execute on function village_suggestions() to service_role;
