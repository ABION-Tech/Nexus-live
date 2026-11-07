-- 0015_files.sql
-- PRD §10.7 FileService / §13.1 S5. Old MVP issue: "Drive file sharing
-- sets every attachment to 'anyone with the link' permanently." Fix:
-- "Remove Drive-sharing system entirely. Production uses scoped object
-- storage" (R2/S3/Supabase Storage), access-controlled to the org, not
-- link-shared. First real consumer is eod_logs.proof_link (0009 —
-- schema exists, zero call sites until this lands), PRD §3's interns
-- "submit proof links" — wiring that column to this table is a follow-up,
-- not part of this migration.
--
-- Polymorphic resource_type/resource_id, same shape activity_log already
-- uses (0009) rather than a per-resource FK per attachable table — a
-- file can attach to any resource type without a schema change per type.
--
-- Two-phase upload (see fileService.ts): `uploaded_at` starts null and is
-- set on confirm, not on the initial presign request — a presigned URL
-- that's requested and never used shouldn't read as a file that exists.
create table files (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id),
  resource_type        text not null,
  resource_id          uuid not null,
  storage_key          text not null unique,
  original_filename    text not null,
  mime_type            text not null,
  size_bytes           bigint not null,
  uploaded_by_user_id  uuid not null references users(id),
  uploaded_at          timestamptz,
  created_at           timestamptz not null default now(),
  archived_at          timestamptz
);
create index idx_files_org on files(org_id);
create index idx_files_resource on files(resource_type, resource_id);

-- Row-Level Security — same tenant_isolation shape every other migration
-- applies (0001/0008/0009's loops).
do $$
begin
  execute 'alter table files enable row level security';
  execute 'alter table files force row level security';
  execute 'create policy tenant_isolation on files using (org_id = current_setting(''app.current_org_id'', true)::uuid)';
end $$;

grant select, insert, update, delete on files to nexus_app;
