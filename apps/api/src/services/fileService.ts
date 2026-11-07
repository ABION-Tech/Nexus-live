// PRD §10.7 FileService. Same layering as taskService.ts/knowledgeService.ts
// — no permission logic here, that's routes/files.ts's job; this file only
// knows how to read/write `files` rows and talk to the storage provider.
//
// Two-phase upload, mirroring why presigned URLs exist at all (PRD §13.4:
// a large file body should never transit this Node process):
//   1. requestFileUpload  — validates size/mime, inserts a `files` row with
//      uploaded_at still null, returns a presigned PUT URL. The client
//      uploads directly to the bucket from here — this API is out of the
//      loop for the actual bytes.
//   2. confirmFileUpload  — client reports success, uploaded_at is set,
//      *this* is what gets logged to activity_log (not step 1 — a
//      presigned URL that's requested and never used shouldn't read as
//      "a file was created").
// A row stuck with uploaded_at null is an abandoned upload (client never
// confirmed, or the PUT failed). No cleanup job for these yet — same
// "flagged, not built" treatment automation/cron items get elsewhere in
// this codebase; a stuck row is inert (never returned by list/download)
// but does consume the unique storage_key until someone adds a sweep.
import crypto from 'node:crypto';
import { withOrgContext } from '../db.js';
import { logActivity, logActivityCreated, diffColumns } from './activityLogService.js';
import { objectStorageProvider } from '../integrations/objectStorageProvider.js';
import type { FileListQuery, FileRecord, FileWithDownloadUrl, RequestFileUploadInput, RequestFileUploadResult } from '@nexus/shared';

interface FileRow {
  id: string;
  org_id: string;
  resource_type: string;
  resource_id: string;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: string; // bigint comes back as string from `pg` — see toFileRecord
  uploaded_by_user_id: string;
  uploaded_at: Date | null;
  created_at: Date;
  archived_at: Date | null;
  category: string | null; // 0023 — only meaningful for resource_type='company_archive'
}

function toFileRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    uploadedByUserId: row.uploaded_by_user_id,
    uploadedAt: row.uploaded_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
    category: row.category ?? undefined,
  };
}

// PRD §13.4 "Request size limits: Per-endpoint maximum payload sizes."
// Files don't transit this API's own body-size limit (they go straight to
// the bucket via presigned URL), so this is enforced here instead, at the
// point the caller declares how big the upload will be. 25MB is a
// deliberately simple v1 default, not derived from any PRD number —
// override via env per-deployment if a real use case needs more.
// `||`, not `??`: an env var that's *present but blank* (exactly what
// .env.example's commented-blank `STORAGE_MAX_UPLOAD_BYTES=` produces
// once copied to `.env` and left unset) is `''`, not `undefined` — `??`
// would let `Number('')` (which is `0`, not NaN) through as the limit,
// silently rejecting every upload as "too large" against a 0-byte cap.
// Caught by this session's real-Postgres verification pass, not by
// inspection — see SESSION_LOG.
const MAX_UPLOAD_BYTES = Number(process.env.STORAGE_MAX_UPLOAD_BYTES || 25 * 1024 * 1024);

export class FileTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(`File is ${sizeBytes} bytes; the maximum allowed is ${maxBytes} bytes.`);
    this.name = 'FileTooLargeError';
  }
}

// 0023 Company docs/archive — org-wide storage quota, same `||` (not
// `??`) reasoning as MAX_UPLOAD_BYTES above: an unset-but-present env var
// is `''`, and `Number('')` is `0`, not NaN, so `??` would silently give
// every org a 0-byte quota. 500MB is a deliberately simple v1 default,
// not derived from any PRD number — override via STORAGE_DEFAULT_ORG_QUOTA_BYTES
// per-deployment, or per-org via organizations.storage_quota_bytes once
// that override path is wired to a route.
const DEFAULT_ORG_QUOTA_BYTES = Number(process.env.STORAGE_DEFAULT_ORG_QUOTA_BYTES || 500 * 1024 * 1024);

export class StorageQuotaExceededError extends Error {
  constructor(
    public usageBytes: number,
    public incomingBytes: number,
    public quotaBytes: number
  ) {
    super(
      `Uploading this file would use ${usageBytes + incomingBytes} of ${quotaBytes} bytes allowed for this organization.`
    );
    this.name = 'StorageQuotaExceededError';
  }
}

/** Resolved quota for an org — `organizations.storage_quota_bytes` if a
 * platform admin has set one, else the env default. Kept here (not in
 * organizationService.ts) since it's purely a files/storage concern, the
 * same reasoning fileService.ts already owns MAX_UPLOAD_BYTES rather than
 * some shared "limits" module. Exported so companyAdmin.ts's overview
 * route can surface it alongside usage, not just requestFileUpload. */
export async function getOrgStorageQuota(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ storage_quota_bytes: string | null }>(
      `select storage_quota_bytes from organizations where id = $1`,
      [orgId]
    );
    const override = rows[0]?.storage_quota_bytes;
    return override != null ? Number(override) : DEFAULT_ORG_QUOTA_BYTES;
  });
}

/** Total bytes currently counted against an org's quota. Counts every
 * uploaded (confirmed) file regardless of resource_type — not just
 * company_archive — and does NOT exclude archived-but-not-deleted rows:
 * per archiveFile's own comment, an archived file's object is
 * deliberately kept in the bucket, so it still costs money and should
 * still count. Abandoned uploads (uploaded_at still null) are excluded —
 * nothing was ever actually written to the bucket for those. */
export async function getOrgStorageUsage(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ total: string }>(
      `select coalesce(sum(size_bytes), 0) as total from files where org_id = $1 and uploaded_at is not null`,
      [orgId]
    );
    return Number(rows[0]?.total ?? 0);
  });
}

// Strips anything that isn't a safe filename character rather than
// rejecting the upload outright — the original name is preserved
// verbatim in `original_filename` for display; only the storage key
// (which becomes part of a URL path) needs to be conservative.
function sanitizeForKey(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100); // slice from the end: keep the extension, drop an overlong prefix
}

export async function requestFileUpload(
  orgId: string,
  input: RequestFileUploadInput,
  uploadedByUserId: string
): Promise<RequestFileUploadResult> {
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new FileTooLargeError(input.sizeBytes, MAX_UPLOAD_BYTES);
  }

  // 0023: org-wide quota, on top of the existing per-file cap above.
  // Checked here (not just at the company_archive UI layer) so the quota
  // is a real backend guarantee regardless of which resource type is
  // uploading — an org that fills its quota with EOD proofs shouldn't be
  // able to keep uploading company docs either, since both draw from the
  // same bucket cost.
  const [usage, quota] = await Promise.all([getOrgStorageUsage(orgId), getOrgStorageQuota(orgId)]);
  if (usage + input.sizeBytes > quota) {
    throw new StorageQuotaExceededError(usage, input.sizeBytes, quota);
  }

  const id = crypto.randomUUID();
  // org_id-prefixed so a bucket shared across orgs (or environments) is
  // still trivially auditable/scriptable per-org from key prefixes alone
  // — belt-and-suspenders alongside the DB-level org_id column, same
  // reasoning DECISIONS.md gives for denormalizing org_id onto every
  // tenant-owned table even when it's join-derivable.
  const storageKey = `${orgId}/${input.resourceType}/${input.resourceId}/${id}-${sanitizeForKey(input.filename)}`;

  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<FileRow>(
      `insert into files (id, org_id, resource_type, resource_id, storage_key, original_filename, mime_type, size_bytes, uploaded_by_user_id, category)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        id,
        orgId,
        input.resourceType,
        input.resourceId,
        storageKey,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        uploadedByUserId,
        input.category ?? null,
      ]
    );
    const file = toFileRecord(rows[0]!);
    const uploadUrl = await objectStorageProvider.getUploadUrl(storageKey, input.mimeType);
    return { file, uploadUrl, expiresInSeconds: 300 };
  });
}

/** Idempotent: confirming an already-confirmed upload just returns the
 * existing row rather than erroring, since a client retry after a dropped
 * response shouldn't produce a second activity_log "created" row. */
export async function confirmFileUpload(orgId: string, id: string, actorUserId: string): Promise<FileRecord | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<FileRow>(
      `select * from files where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, id]
    );
    const before = beforeRows[0];
    if (!before) return null;
    if (before.uploaded_at) return toFileRecord(before); // already confirmed — no-op

    const { rows } = await client.query<FileRow>(
      `update files set uploaded_at = now() where org_id = $1 and id = $2 returning *`,
      [orgId, id]
    );
    const after = rows[0]!;
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'files', resourceId: id });
    return toFileRecord(after);
  });
}

/** Only ever returns confirmed, non-archived files — an abandoned
 * presigned-upload row (never confirmed) has nothing real to download,
 * and an archived file's download link shouldn't be re-derivable through
 * this path even though the object may still exist in the bucket (see
 * archiveFile's comment on why the object itself isn't deleted). */
export async function getFileDownloadUrl(orgId: string, id: string): Promise<FileWithDownloadUrl | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<FileRow>(
      `select * from files where org_id = $1 and id = $2 and uploaded_at is not null and archived_at is null`,
      [orgId, id]
    );
    const row = rows[0];
    if (!row) return null;
    const downloadUrl = await objectStorageProvider.getDownloadUrl(row.storage_key);
    return { ...toFileRecord(row), downloadUrl, expiresInSeconds: 300 };
  });
}

/** Just enough of a file row to ask fileResourceAuth.ts "who does this
 * attach to" — deliberately not gated behind uploaded_at/archived_at
 * like the other reads here, because routes/files.ts needs this *before*
 * it knows whether the caller is even allowed to see the file, to decide
 * which authorization path applies. Returns null (not partial data) for
 * a nonexistent id so the route can treat "no such file" and "file in
 * another org" identically — RLS already makes the latter look like the
 * former. */
export async function getFileResourceRef(orgId: string, id: string): Promise<{ resourceType: string; resourceId: string } | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ resource_type: string; resource_id: string }>(
      `select resource_type, resource_id from files where org_id = $1 and id = $2`,
      [orgId, id]
    );
    return rows[0] ? { resourceType: rows[0].resource_type, resourceId: rows[0].resource_id } : null;
  });
}

export async function listFilesForResource(orgId: string, query: FileListQuery): Promise<FileRecord[]> {
  return withOrgContext(orgId, async (client) => {
    const clauses = ['org_id = $1', 'resource_type = $2', 'resource_id = $3', 'uploaded_at is not null'];
    if (!query.includeArchived) clauses.push('archived_at is null');
    const { rows } = await client.query<FileRow>(
      `select * from files where ${clauses.join(' and ')} order by created_at desc`,
      [orgId, query.resourceType, query.resourceId]
    );
    return rows.map(toFileRecord);
  });
}

/** Archive, not hard-delete — same convention every other resource in
 * this schema follows. Deliberately does NOT call
 * objectStorageProvider.deleteObject: an archived record disappearing
 * from list/download endpoints is the actual access-control boundary
 * (RLS + the `archived_at is null` filter above), matching how an
 * archived task's row still exists but stops appearing live. Actually
 * deleting the object is a separate, irreversible action this function
 * intentionally doesn't take — revisit only if a real retention/GDPR
 * requirement calls for it. */
export async function archiveFile(orgId: string, id: string, actorUserId: string): Promise<FileRecord | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<FileRow>(
      `select * from files where org_id = $1 and id = $2 and archived_at is null`,
      [orgId, id]
    );
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<FileRow>(
      `update files set archived_at = now() where org_id = $1 and id = $2 returning *`,
      [orgId, id]
    );
    const after = rows[0]!;
    const changes = diffColumns(before, after, ['archived_at']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'files', resourceId: id, changes });
    }
    return toFileRecord(after);
  });
}
