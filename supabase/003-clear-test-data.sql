-- ============================================================
--  Clear test data — RUN THIS BEFORE THE EVENT
--
--  Removes every vehicle entry made during testing, plus the sample
--  blocks that shipped with the schema. Create the real blocks from
--  the /admin/blocks screen.
-- ============================================================

-- Remove all vehicle entries
delete from vehicles;

-- Remove the sample blocks that came with schema.sql
delete from blocks where name in ('A-1', 'A-2', 'B-1');

-- Verify
select
  (select count(*) from vehicles) as vehicles_left,
  (select count(*) from blocks)   as blocks_left;
