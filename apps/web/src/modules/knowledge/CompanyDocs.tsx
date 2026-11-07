// Company Docs (0023, ADMIN_BUILD_GUIDE.md Session 8). Lives under the
// Knowledge section in ia.ts rather than as its own top-level IA entry —
// ia.ts's own header says the IA is "a direct port of PRD §7.2's
// finalized subsection tree" (a closed 01–11 numbered set); inventing a
// new top-level number for this would be exactly the kind of scope
// change that file's docstring warns against. Knowledge is also the
// closest existing top-level section by access shape: read-open to every
// org member, same as this feature needs, rather than leader-gated the
// way the /admin/* shells are.
//
// Flat list, no folder tree, matching the finalized scope — icon by
// mime-type family, category filter chips along the top, upload visible
// to leaders only. Tap behavior: previewable types open inline via an
// in-app viewer (using the presigned download URL, or the IndexedDB blob
// cache if this file was already opened before); everything else opens
// the presigned URL in a new tab. The link is always the file's own
// presigned URL — there's no folder-view concept to route around, since
// this reuses the existing files infra rather than a Drive picker.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Badge, Input, LoadingState, ErrorState, EmptyState, Modal, useToast } from '../../components/ui';
import {
  fetchArchiveFiles,
  requestArchiveUpload,
  archiveArchiveFile,
  getArchiveDownloadUrl,
  isQuotaExceededError,
  iconFamilyForMimeType,
  isInlinePreviewable,
  type FileIconFamily,
} from '../../services/companyArchiveService';
import { getCachedArchiveMetadata, replaceCachedArchiveMetadata, getCachedBlob, cacheBlob } from '../../services/companyArchiveCache';
import type { CurrentUser } from '../../services/authService';
import type { FileRecord } from '@nexus/shared';

type ListState =
  | { status: 'loading'; files: FileRecord[] } // files here may be the cached set, rendered while the network call is still in flight
  | { status: 'error'; message: string; files: FileRecord[] }
  | { status: 'ready'; files: FileRecord[] };

const ICON_BY_FAMILY: Record<FileIconFamily, string> = {
  doc: '📄',
  sheet: '📊',
  pdf: '📕',
  image: '🖼️',
  generic: '📁',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CompanyDocs({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const canUpload = user.role === 'leader'; // server's real boundary is files.create / the leader-bypass in hasPermission; this is UX only
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<ListState>({ status: 'loading', files: [] });
  const [category, setCategory] = useState('');
  const [uploadCategory, setUploadCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ file: FileRecord; url: string } | null>(null);

  function load() {
    // Instant paint from cache first — this resolves synchronously-ish
    // from local storage, no network — then the real network list
    // replaces both the on-screen state and the cache once it lands.
    getCachedArchiveMetadata().then((cached) => {
      if (cached.length > 0) setState((prev) => (prev.status === 'loading' ? { status: 'loading', files: cached } : prev));
    });

    fetchArchiveFiles(user.orgId)
      .then((files) => {
        setState({ status: 'ready', files });
        void replaceCachedArchiveMetadata(files);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        // Keep whatever cached files we already painted rather than
        // clearing the list on a network failure — offline should look
        // like "a bit stale", not "empty".
        setState((prev) => ({ status: 'error', message, files: prev.files }));
      });
  }

  useEffect(load, [user.orgId]);

  const categories = useMemo(() => {
    const set = new Set(state.files.map((f) => f.category).filter((c): c is string => !!c));
    return Array.from(set).sort();
  }, [state.files]);

  const filtered = useMemo(() => {
    if (!category) return state.files;
    return state.files.filter((f) => f.category === category);
  }, [state.files, category]);

  async function handleUploadClick() {
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file next time
    if (!file) return;

    setUploading(true);
    try {
      const created = await requestArchiveUpload(user.orgId, file, uploadCategory.trim() || undefined);
      setState((prev) => ({ status: 'ready', files: [created, ...prev.files] }));
      void replaceCachedArchiveMetadata([created, ...state.files]);
      show(`${created.originalFilename} uploaded.`, 'success');
    } catch (err: unknown) {
      if (isQuotaExceededError(err)) {
        show("This organization's storage quota is full. Ask an admin to free up space or raise the limit.", 'danger');
      } else {
        show(err instanceof Error ? err.message : 'Upload failed.', 'danger');
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleArchive(file: FileRecord) {
    try {
      await archiveArchiveFile(file.id);
      const remaining = state.files.filter((f) => f.id !== file.id);
      setState({ status: 'ready', files: remaining });
      void replaceCachedArchiveMetadata(remaining);
      show(`${file.originalFilename} removed.`, 'default');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not remove the file.', 'danger');
    }
  }

  async function handleOpen(file: FileRecord) {
    const previewable = isInlinePreviewable(file.mimeType);

    if (!previewable) {
      // Non-previewable (docx, xlsx, zip, etc.) — open the presigned URL
      // directly in a new tab/system browser rather than trying to
      // render it. Always the file's own download URL, never a
      // folder-view link.
      try {
        const { downloadUrl } = await getArchiveDownloadUrl(file.id);
        window.open(downloadUrl, '_blank', 'noopener');
      } catch (err: unknown) {
        show(err instanceof Error ? err.message : 'Could not open the file.', 'danger');
      }
      return;
    }

    // Previewable — try the IndexedDB blob cache first for instant
    // re-open, falling back to fetching the presigned URL and caching
    // the result for next time.
    const cached = await getCachedBlob(file.id);
    if (cached) {
      setPreview({ file, url: URL.createObjectURL(cached.blob) });
      return;
    }

    try {
      const { downloadUrl } = await getArchiveDownloadUrl(file.id);
      const res = await fetch(downloadUrl);
      const blob = await res.blob();
      void cacheBlob(file.id, blob, file.mimeType);
      setPreview({ file, url: URL.createObjectURL(blob) });
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not open the file.', 'danger');
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between">
        <h2>Company Docs</h2>
        {canUpload && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 160 }}>
              <Input
                placeholder="Category (optional)"
                value={uploadCategory}
                onChange={(e) => setUploadCategory(e.target.value)}
              />
            </div>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileSelected} />
            <Button onClick={handleUploadClick} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        )}
      </div>

      {state.status === 'loading' && state.files.length === 0 && <LoadingState label="Loading company docs…" />}
      {state.status === 'error' && (
        <ErrorState title="Couldn't refresh company docs" description={state.message} onRetry={load} />
      )}

      {state.files.length > 0 && categories.length > 0 && (
        // Category filter chips — small Buttons rather than a dropdown,
        // since the finalized scope calls these "chips" and expected
        // counts per org are small. Badge has no onClick/tone for a
        // "selected" state, so Button (variant swap) carries the chip
        // look instead.
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" variant={category === '' ? 'primary' : 'ghost'} onClick={() => setCategory('')}>
            All
          </Button>
          {categories.map((c) => (
            <Button key={c} size="sm" variant={category === c ? 'primary' : 'ghost'} onClick={() => setCategory(c)}>
              {c}
            </Button>
          ))}
        </div>
      )}

      {state.files.length === 0 && state.status !== 'loading' && (
        <EmptyState
          title="No company docs yet"
          description={
            canUpload
              ? 'Upload the first document — anyone in the org will be able to view it here.'
              : 'A leader hasn\u2019t added any company documents yet.'
          }
          action={canUpload ? <Button onClick={handleUploadClick}>Upload</Button> : undefined}
        />
      )}

      {filtered.length > 0 && (
        <div className="nx-stack nx-stack--sm">
          {filtered.map((file) => (
            <Card key={file.id} interactive style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 12 }} onClick={() => handleOpen(file)}>
              <span style={{ fontSize: 22 }}>{ICON_BY_FAMILY[iconFamilyForMimeType(file.mimeType)]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong>{file.originalFilename}</strong>
                </div>
                <div style={{ opacity: 0.7, fontSize: 12 }}>{formatBytes(file.sizeBytes)}</div>
              </div>
              {file.category && <Badge tone="neutral">{file.category}</Badge>}
              {canUpload && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleArchive(file);
                  }}
                >
                  Remove
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal open={preview !== null} title={preview?.file.originalFilename} onClose={() => setPreview(null)}>
        {preview?.file.mimeType.startsWith('image/') && (
          <img src={preview.url} alt={preview.file.originalFilename} style={{ maxWidth: '100%' }} />
        )}
        {preview && (preview.file.mimeType === 'application/pdf' || preview.file.mimeType === 'text/plain') && (
          <iframe title={preview.file.originalFilename} src={preview.url} style={{ width: '100%', height: '70vh', border: 'none' }} />
        )}
      </Modal>
    </div>
  );
}
