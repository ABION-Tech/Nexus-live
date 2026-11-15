-- Session 60 (C-12) — task history reads audit_log by record ("everything
-- that happened to this task"). There was no index for that, only the
-- primary key.
create index if not exists audit_log_resource on audit_log (org_id, resource_type, resource_id, "timestamp" desc);
