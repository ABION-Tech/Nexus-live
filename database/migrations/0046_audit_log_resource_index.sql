-- Session 60 — audit_log read by record (e.g. a company's import entries
-- for one task). There was no index for that, only the primary key.
create index if not exists audit_log_resource on audit_log (org_id, resource_type, resource_id, "timestamp" desc);
