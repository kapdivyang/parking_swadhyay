-- ============================================================
--  FIX: grant table access to service_role
--
--  "Automatically expose new tables" was switched off when the project
--  was created, so new tables started with no role permissions at all.
--
--  Run this whole file in Supabase > SQL Editor.
-- ============================================================

grant usage on schema public to service_role;

grant select, insert, update, delete on blocks      to service_role;
grant select, insert, update, delete on vehicles    to service_role;
grant select                        on block_status to service_role;
grant execute on function search_vehicles(text)     to service_role;

-- Browser-facing keys are deliberately given nothing.
revoke all on blocks       from anon, authenticated;
revoke all on vehicles     from anon, authenticated;
revoke all on block_status from anon, authenticated;
