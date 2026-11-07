// Web-side fileService — wraps apps/api/src/routes/files.ts (PRD §10.7
// FileService). First real caller: EodReport.tsx's proof attachment
// (PRD §3 "interns submit proof links"), via resourceType='eod_logs'
// against the generic polymorphic files table — see files.ts's own
// header for why this stayed a flat files.read/create/delete grant
// rather than per-record trust (PRD §13.3 check 4), which is still
// deliberately deferred.
import { apiClient } from './apiClient';
import type { FileRecord, FileWithDownloadUrl, RequestFileUploadInput } from '@nexus/shared';

export function listFiles(resourceType: string, resourceId: string): Promise<FileRecord[]> {
  return apiClient
    .get<{ files: FileRecord[] }>(
      `/files?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`
    )
    .then((r) => r.files);
}

// Download URLs aren't included in list/upload responses (they're
// presigned per-request, short-lived — fileService.ts's own
// getFileDownloadUrl comment) so callers fetch this only at the moment
// someone actually clicks to open/download a file.
export function getFileDownloadUrl(id: string): Promise<FileWithDownloadUrl> {
  return apiClient.get<FileWithDownloadUrl>(`/files/${id}`);
}

// Archive, not delete — same convention as knowledgeService.archiveKnowledgeEntry.
export function archiveFile(id: string): Promise<FileRecord> {
  return apiClient.delete<FileRecord>(`/files/${id}`);
}

/**
 * Full two-phase upload in one call: request a presigned PUT → PUT the
 * raw bytes straight to the bucket (never through apiClient/API_BASE —
 * this is deliberately a plain fetch to whatever URL the presign
 * returned, matching fileService.ts's own "this API process never
 * touches file bytes" contract) → confirm.
 *
 * If the PUT itself fails (network blip, expired presign, CORS), the
 * `files` row this created is left with uploaded_at still null — same
 * "abandoned upload" shape fileService.ts's header describes, not a
 * half-created record callers need to clean up themselves.
 */
export async function uploadFile(input: RequestFileUploadInput, file: File): Promise<FileRecord> {
  const { file: fileRow, uploadUrl } = await apiClient.post<{
    file: FileRecord;
    uploadUrl: string;
    expiresInSeconds: number;
  }>('/files', input);

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': input.mimeType },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error('Upload to storage failed. The proof file was not attached.');
  }

  return apiClient.post<FileRecord>(`/files/${fileRow.id}/confirm`);
}
