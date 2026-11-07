-- 0033_task_priority.sql
-- PRD §8.2/§13.7 gap, found during ABION demo-seed prep: `tasks` had no
-- `priority` column anywhere across migrations 0001-0032, and no
-- PRIORITY_WEIGHT-equivalent in the API layer. In the legacy GAS system
-- priority (URGENT/HIGH/MEDIUM/LOW) drove ESCALATION_TIERS timing, the
-- AI Attention Queue's ranking, and task card color — real functionality
-- dropped, not just unseeded. Added back as a first-class column (same
-- text+check shape as `status`, 0001_init.sql) rather than folded into
-- `description`, so it can be filtered/ordered/indexed like any other
-- task field.
--
-- Default 'medium' (not null) so every pre-existing row gets a sane
-- value on migration rather than every read site having to null-check.

alter table tasks add column priority text not null default 'medium'
  check (priority in ('urgent', 'high', 'medium', 'low'));

-- Backs Failsafe/Attention Queue ordering (analyticsService.ts) — open
-- tasks ranked by priority first. Same "index what you order by"
-- pattern as idx_task_trends_org_date (0001_init.sql).
create index idx_tasks_org_priority on tasks(org_id, priority)
  where archived_at is null and status != 'done';
