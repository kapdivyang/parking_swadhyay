-- ============================================================
--  007 — Bridge for the one-argument search_vehicles(q)
--
--  004 replaced search_vehicles(q) with search_vehicles(q, village, taluka).
--  If the database is migrated before the new code is deployed, the live
--  site keeps calling the old one-argument form and every search returns
--  500. This puts that form back, delegating to the new function.
--
--  Postgres resolves the two by argument count, and PostgREST picks by the
--  names in the request body, so both live side by side without ambiguity.
--
--  Once the new code is deployed nothing calls this any more. It is safe
--  to keep as a rollback cushion, or to drop with:
--    drop function if exists search_vehicles(text);
--
--  Safe to re-run.
-- ============================================================

create or replace function search_vehicles(q text)
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
  select * from search_vehicles(q, '', '');
$$;

grant execute on function search_vehicles(text) to service_role;
