-- 0023_company_archive.sql
-- ADMIN_BUILD_GUIDE.md "Session 8" (Company docs/archive). Two columns
-- Session 45's app code (fileService.ts, fileResourceAuth.ts's
-- companyArchiveAuthorizer) reads/writes but that no prior migration
-- ever added — caught while starting Session 46's cron work, not caught
-- at the time: `insert into files (..., category)` and
-- `select storage_quota_bytes from organizations` would both have
-- failed with "column does not exist" against a real database. No
-- session between 45 and now ran this against live Postgres to catch it
-- (same standing no-`node_modules`/no-live-DB constraint every session
-- in SESSION_LOG has flagged) — this is that gap surfacing for real.

-- `files.category` — only ever set for resource_type = 'company_archive'
-- rows (see fileService.ts's own comment on the column); nullable and
-- unconstrained rather than a check() tying it to resource_type, since
-- category is a free-text org-defined label (same "free text" pattern
-- 0008's network_cos.category and 0009's org_contacts.category already
-- use), not a closed enum.
alter table files add column category text;

-- `organizations.storage_quota_bytes` — per-org override of
-- fileService.ts's STORAGE_DEFAULT_ORG_QUOTA_BYTES env fallback.
-- Nullable: null means "use the env default," matching
-- getOrgStorageQuota's own `override != null ? Number(override) : DEFAULT_ORG_QUOTA_BYTES`
-- read exactly — a 0 value is a real (if unusual) "block all uploads"
-- override and must stay distinct from "unset."
alter table organizations add column storage_quota_bytes bigint;
