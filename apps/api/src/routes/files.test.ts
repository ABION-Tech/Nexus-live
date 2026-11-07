// PRD §10.7 FileService / §13.1 S5 route tests. Same strategy as
// network.test.ts: mock sessionService (so requireAuth/req.sessionUser
// resolve without a real cookie/DB round trip) and mock fileService
// entirely (no Postgres needed — this is the route/RBAC/validation
// layer, not a migration/integration test; the real-Postgres pass for
// this session is documented separately in SESSION_LOG).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { FileRecord, FileWithDownloadUrl } from '@nexus/shared';

const GRANTED_TOKEN = 'granted-token';
const UNGRANTED_TOKEN = 'ungranted-token';
const OWNER_TOKEN = 'owner-token';
const TEAMMATE_TOKEN = 'teammate-token';

const GRANTED = { sessionId: 's1', userId: 'user-granted', orgId: 'org-1', role: 'member', name: 'Granted', email: 'granted@abion.test' };
const UNGRANTED = { sessionId: 's2', userId: 'user-ungranted', orgId: 'org-1', role: 'member', name: 'Ungranted', email: 'ungranted@abion.test' };
// Session 31 additions — neither has a flat `files.*` grant. OWNER is the
// user the eod_logs row (eod-1) is filed *for* (files.ts's per-record
// fallback should let them through on ownership alone, same as
// eod.ts's own-filing exception). TEAMMATE isn't the owner but holds the
// flat `eod.read` grant — the exact Session 30 scenario: can already
// read the EOD entry, should now also be able to read its attachment.
const OWNER = { sessionId: 's3', userId: 'user-owner', orgId: 'org-1', role: 'member', name: 'Owner', email: 'owner@abion.test' };
const TEAMMATE = { sessionId: 's4', userId: 'user-teammate', orgId: 'org-1', role: 'member', name: 'Teammate', email: 'teammate@abion.test' };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === GRANTED_TOKEN) return GRANTED;
    if (token === UNGRANTED_TOKEN) return UNGRANTED;
    if (token === OWNER_TOKEN) return OWNER;
    if (token === TEAMMATE_TOKEN) return TEAMMATE;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    // GRANTED has every flat grant this route checks. TEAMMATE has only
    // `eod.read` — enough to read a colleague's EOD-attached file via the
    // per-record fallback (fileResourceAuth.ts), not enough to upload/
    // archive one (that needs `eod.create`, mirroring eod.ts's own
    // own-vs-filing-for-someone-else split).
    hasPermission: vi.fn(async (user: { userId: string }, resource: string, action: string) => {
      if (user.userId === GRANTED.userId) return true;
      if (user.userId === TEAMMATE.userId && resource === 'eod' && action === 'read') return true;
      return false;
    }),
  };
});

// getEodLogById is fileResourceAuth.ts's real dependency for the
// eod_logs authorizer — mocked here (not fileResourceAuth.js itself) so
// the actual per-record logic in fileResourceAuth.ts runs for real in
// these tests, same "mock the DB edge, not the logic under test"
// approach files.test.ts already takes with fileService.js.
vi.mock('../services/eodService.js', () => ({
  getEodLogById: vi.fn(async (_orgId: string, id: string) =>
    id === 'eod-1' ? { id: 'eod-1', orgId: 'org-1', userId: OWNER.userId, filedByUserId: OWNER.userId, date: '2026-01-01', summary: 'x', createdAt: '', updatedAt: '' } : null
  ),
}));

const baseFile: FileRecord = {
  id: 'file-1',
  orgId: 'org-1',
  resourceType: 'eod_logs',
  resourceId: 'eod-1',
  originalFilename: 'proof.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
  uploadedByUserId: GRANTED.userId,
  uploadedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../services/fileService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/fileService.js')>('../services/fileService.js');
  return {
    ...actual, // keeps FileTooLargeError real
    requestFileUpload: vi.fn(async (_orgId: string, input: { sizeBytes: number }) => {
      const maxBytes = 25 * 1024 * 1024; // mirrors fileService.ts's default MAX_UPLOAD_BYTES
      if (input.sizeBytes > maxBytes) {
        throw new actual.FileTooLargeError(input.sizeBytes, maxBytes);
      }
      return { file: baseFile, uploadUrl: 'https://bucket.example.test/signed-put', expiresInSeconds: 300 };
    }),
    confirmFileUpload: vi.fn(async (_orgId: string, id: string) =>
      id === baseFile.id ? { ...baseFile } : null
    ),
    getFileDownloadUrl: vi.fn(async (_orgId: string, id: string): Promise<FileWithDownloadUrl | null> =>
      id === baseFile.id
        ? { ...baseFile, downloadUrl: 'https://bucket.example.test/signed-get', expiresInSeconds: 300 }
        : null
    ),
    listFilesForResource: vi.fn(async (_orgId: string, query: { resourceId: string }) =>
      query.resourceId === baseFile.resourceId ? [baseFile] : []
    ),
    archiveFile: vi.fn(async (_orgId: string, id: string) =>
      id === baseFile.id ? { ...baseFile, archivedAt: '2026-01-02T00:00:00.000Z' } : null
    ),
    getFileResourceRef: vi.fn(async (_orgId: string, id: string) =>
      id === baseFile.id ? { resourceType: baseFile.resourceType, resourceId: baseFile.resourceId } : null
    ),
  };
});

describe('Files — PRD §10.7 FileService routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('POST / (request upload)', () => {
    const validBody = {
      resourceType: 'eod_logs',
      resourceId: 'eod-1',
      filename: 'proof.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    };

    it('returns a presigned upload result for a caller with files.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().uploadUrl).toBe('https://bucket.example.test/signed-put');
    });

    it('rejects a caller without files.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a missing filename with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { ...validBody, filename: undefined },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-positive sizeBytes with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { ...validBody, sizeBytes: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 413 for an oversized file', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { ...validBody, sizeBytes: 999 * 1024 * 1024 },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('file_too_large');
    });
  });

  describe('POST /:id/confirm', () => {
    it('confirms an upload for a caller with files.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/files/${baseFile.id}/confirm`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(baseFile.id);
    });

    it('404s confirming an unknown file', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files/unknown-id/confirm',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects a caller without files.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/files/${baseFile.id}/confirm`,
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /:id (download url)', () => {
    it('returns a signed download url for a caller with files.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().downloadUrl).toBe('https://bucket.example.test/signed-get');
    });

    it('rejects a caller without files.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('404s an unknown file id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/files/unknown-id',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET / (list)', () => {
    it('lists files for a resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/files?resourceType=${baseFile.resourceType}&resourceId=${baseFile.resourceId}`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().files).toHaveLength(1);
    });

    it('requires resourceType and resourceId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /:id (archive)', () => {
    it('archives a file for a caller with files.delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().archivedAt).toBeTruthy();
    });

    it('rejects a caller without files.delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('404s archiving an unknown file', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/files/unknown-id',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // Session 31 — per-record file trust (PRD §13.3 check 4). See
  // fileResourceAuth.ts; baseFile is attached to eod_logs/eod-1, owned
  // by OWNER, and TEAMMATE holds `eod.read` (mocked above) but not
  // `eod.create` and is not the owner.
  describe('per-record fallback (PRD §13.3 check 4)', () => {
    it('lets the eod_logs owner read the attachment without a flat files.read grant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('lets the eod_logs owner start an upload against their own record without a flat files.create grant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
        payload: { resourceType: 'eod_logs', resourceId: 'eod-1', filename: 'proof.png', mimeType: 'image/png', sizeBytes: 1024 },
      });
      expect(res.statusCode).toBe(201);
    });

    it('lets the eod_logs owner archive their own attachment without a flat files.delete grant', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("lets a teammate with eod.read (not the owner) read a colleague's attachment — the Session 30 gap", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${TEAMMATE_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('does not let eod.read alone (no ownership, no eod.create) archive the attachment', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${TEAMMATE_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('still denies a caller with no flat grant, no ownership, and no eod grant', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${baseFile.id}`,
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('falls through to a flat 403 for a resourceType with no registered authorizer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/files?resourceType=knowledge_entries&resourceId=some-id',
        headers: { cookie: `nexus_session=${TEAMMATE_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
