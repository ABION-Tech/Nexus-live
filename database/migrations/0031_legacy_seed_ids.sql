-- 0031_legacy_seed_ids.sql
-- Adds a nullable traceability column to `tasks` and `goals` so the
-- ABION demo seed (database/seed/ABION_DEMO_SEED.sql) can resolve
-- cross-references that exist in the legacy sheet — `tasks.Depends On`
-- pointing at another row's own sheet ID (e.g. "NEXUS-001"), and a
-- goal's `TaskIDs` list pointing at the AI-decomposed task rows it
-- produced — without inventing a second identity system. `null` for
-- every row not created by that seed; nothing in the app reads this
-- column, it exists purely so a one-time SQL import can self-join.
--
-- Kept as a small permanent column rather than a temp table because the
-- same need will recur every time more of the legacy sheet gets
-- imported incrementally — same "don't build a second import mechanism
-- next time" reasoning as this codebase's other "why keep this" notes.

alter table tasks add column legacy_sheet_id text;
alter table goals add column legacy_sheet_id text;

create index idx_tasks_legacy_sheet_id on tasks(legacy_sheet_id) where legacy_sheet_id is not null;
create unique index idx_goals_legacy_sheet_id on goals(legacy_sheet_id) where legacy_sheet_id is not null;
