// Web-side companyArchiveService — thin wrapper over fileService.ts's
// generic two-phase upload flow, scoped to resourceType='company_archive'
// (0023, ADMIN_BUILD_GUIDE.md Session 8). No new API routes: this reuses
// the same polymorphic /files endpoints eod_logs attachments already go
// through — see fileResourceAuth.ts's companyArchiveAuthorizer for the
// read/write rule this rides on (any org member reads, leader-only
// writes via the flat files.create grant leaders already hold).
import { ApiError } from './apiClient';
import { listFiles, uploadFile, archiveFile as archiveFileById, getFileDownloadUrl } from './fileService';
import type { FileRecord, FileWithDownloadUrl } from '@nexus/shared';

const RESOURCE_TYPE = 'company_archive';

/** company_archive is org-scoped, not row-scoped — resourceId is always
 * the caller's own org id (see fileResourceAuth.ts's comment on why).
 * Callers pass it explicitly (from CurrentUser.orgId) rather than this
 * module guessing it, so there's one obvious source of truth for it. */
export function fetchArchiveFiles(orgId: string): Promise<FileRecord[]> {
  return listFiles(RESOURCE_TYPE, orgId);
}

export function requestArchiveUpload(orgId: string, file: File, category?: string): Promise<FileRecord> {
  return uploadFile(
    {
      resourceType: RESOURCE_TYPE,
      resourceId: orgId,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      category,
    },
    file
  );
}

export function archiveArchiveFile(id: string): Promise<FileRecord> {
  return archiveFileById(id);
}

export function getArchiveDownloadUrl(id: string): Promise<FileWithDownloadUrl> {
  return getFileDownloadUrl(id);
}

/** True specifically for the org-wide storage cap (413
 * storage_quota_exceeded), distinct from the per-file 25MB cap (413
 * file_too_large) — lets the UI tell someone "ask a leader to raise the
 * quota" instead of "pick a smaller file". */
export function isQuotaExceededError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'storage_quota_exceeded';
}

// Mime-type-family icon lookup — no real thumbnails per the finalized
// scope, just a coarse family bucket for the row icon.
export type FileIconFamily = 'doc' | 'sheet' | 'pdf' | 'image' | 'generic';

export function iconFamilyForMimeType(mimeType: string): FileIconFamily {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('spreadsheet') || mimeType === 'text/csv') return 'sheet';
  if (mimeType.includes('word') || mimeType.startsWith('text/')) return 'doc';
  return 'generic';
}

/** Previewable inline (image, PDF, plain text) vs. "open elsewhere"
 * (docx, xlsx, zip, etc.) — matches the finalized tap behavior exactly. */
export function isInlinePreviewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf' || mimeType === 'text/plain';
}
