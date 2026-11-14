-- 0042_task_external_ref.sql
-- Session 59. Tasks imported from another system (Synergia, the original
-- Google Sheet) remember where they came from, so an import can be run
-- again without creating duplicates: one task per (company, external_ref).
alter table tasks add column external_ref text;
create unique index tasks_org_external_ref_uq on tasks (org_id, external_ref) where external_ref is not null;
