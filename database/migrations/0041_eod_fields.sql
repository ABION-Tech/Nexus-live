-- 0041_eod_fields.sql
-- Session 58. The original HTML app's EOD form had five parts; NEXUS kept
-- one ("summary"). `summary` stays as "What I completed (with proof)" and
-- these four come back. All optional, so every existing EOD is still valid.
alter table eod_logs
  add column moved_forward text,
  add column key_achievement text,
  add column blockers text,
  add column tomorrow_plan text;

-- The Activity Log reads EODs by date range.
create index if not exists eod_logs_org_date_idx on eod_logs (org_id, date desc);
