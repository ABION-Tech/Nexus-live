// PRD §10.7 FileService / §13.1 S5 routes.
//
// Session 31: per-record file trust (PRD §13.3 check 4), previously on
// hold — see fileResourceAuth.ts for the actual authorization dispatch.
// Every check below is now two-tier:
//   1. flat `files.<action>` grant — unchanged from before, still the
//      fast/common path (e.g. a Leader, or anyone granted blanket file
//      access).
//   2. per-record fallback — if the flat grant is missing AND the file's
//      `resourceType` has a registered authorizer (fileResourceAuth.ts),
//      defer to that resource's own read/write rules for this specific
//      record (e.g. eod_logs: own entry, or holding `eod.read`/
//      `eod.create` the way eod.ts itself checks). A resourceType with
//      no authorizer registered falls through to a flat 403 — the exact
//      pre-Session-31 behavior, so nothing gets silently more permissive.
//
// This resolves the concrete gap Session 30 proved live: a same-org
// teammate with no `files` grant, but with `eod.read` (or ownership of
// the entry), can now read that EOD log's proof attachment — matching
// the access they already had to the EOD entry itself.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import { checkFileResourceAccess, hasFileResourceAuthorizer } from '../services/fileResourceAuth.js';
import {
  archiveFile,
  confirmFileUpload,
  FileTooLargeError,
  getFileDownloadUrl,
  getFileResourceRef,
  listFilesForResource,
  requestFileUpload,
  StorageQuotaExceededError,
} from '../services/fileService.js';
import type { RequestFileUploadInput } from '@nexus/shared';
import type { SessionUser } from '../services/sessionService.js';

/** Shared two-tier check for routes that already know resourceType/
 * resourceId (POST / and GET /, where they come from the request body
 * or query rather than an existing file row). */
async function canAccessResource(
  user: SessionUser,
  flatResource: 'files',
  flatAction: 'read' | 'create',
  resourceType: string,
  resourceId: string,
  mode: 'read' | 'write'
): Promise<boolean> {
  if (await hasPermission(user, flatResource, flatAction)) return true;
  if (!hasFileResourceAuthorizer(resourceType)) return false;
  return checkFileResourceAccess(user, resourceType, resourceId, mode);
}

export async function registerFileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Step 1 of the two-phase upload — see fileService.ts's header.
  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as Partial<RequestFileUploadInput>;
    if (!body?.resourceType || typeof body.resourceType !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'resourceType is required.' });
      return;
    }
    if (!body?.resourceId || typeof body.resourceId !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'resourceId is required.' });
      return;
    }
    if (!body?.filename || typeof body.filename !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'filename is required.' });
      return;
    }
    if (!body?.mimeType || typeof body.mimeType !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'mimeType is required.' });
      return;
    }
    if (typeof body?.sizeBytes !== 'number' || body.sizeBytes <= 0) {
      reply.status(400).send({ error: 'invalid_body', message: 'sizeBytes must be a positive number.' });
      return;
    }

    if (!(await canAccessResource(user, 'files', 'create', body.resourceType, body.resourceId, 'write'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'files' for this record." });
      return;
    }

    try {
      const result = await requestFileUpload(user.orgId, body as RequestFileUploadInput, user.userId);
      reply.status(201).send(result);
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        reply.status(413).send({ error: 'file_too_large', message: err.message });
        return;
      }
      // Same 413 as FileTooLargeError above — both are "this upload
      // can't be accepted because of its size", just measured against a
      // per-file cap vs. an org-wide total. A distinct `error` code
      // lets the client tell them apart (e.g. to show "ask an admin to
      // raise your quota" instead of "pick a smaller file").
      if (err instanceof StorageQuotaExceededError) {
        reply.status(413).send({ error: 'storage_quota_exceeded', message: err.message });
        return;
      }
      throw err;
    }
  });

  // Step 2 — client reports the presigned PUT succeeded. Same
  // `files.create` grant (or per-record write access) as step 1, not a
  // separate permission: this is completing an upload the caller already
  // had permission to start, not a distinct action.
  app.post('/:id/confirm', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    if (!(await hasPermission(user, 'files', 'create'))) {
      const ref = await getFileResourceRef(user.orgId, id);
      if (!ref) {
        reply.status(404).send({ error: 'not_found', message: 'File not found or already archived.' });
        return;
      }
      const allowed = hasFileResourceAuthorizer(ref.resourceType) && (await checkFileResourceAccess(user, ref.resourceType, ref.resourceId, 'write'));
      if (!allowed) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'files' for this record." });
        return;
      }
    }

    const file = await confirmFileUpload(user.orgId, id, user.userId);
    if (!file) {
      reply.status(404).send({ error: 'not_found', message: 'File not found or already archived.' });
      return;
    }
    reply.send(file);
  });

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { resourceType?: string; resourceId?: string; includeArchived?: string };
    if (!q.resourceType || !q.resourceId) {
      reply.status(400).send({ error: 'invalid_query', message: 'resourceType and resourceId are required.' });
      return;
    }

    if (!(await canAccessResource(user, 'files', 'read', q.resourceType, q.resourceId, 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'files' for this record." });
      return;
    }

    const files = await listFilesForResource(user.orgId, {
      resourceType: q.resourceType,
      resourceId: q.resourceId,
      includeArchived: q.includeArchived === 'true',
    });
    reply.send({ files });
  });

  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    if (!(await hasPermission(user, 'files', 'read'))) {
      const ref = await getFileResourceRef(user.orgId, id);
      if (!ref) {
        reply.status(404).send({ error: 'not_found', message: 'File not found, not yet uploaded, or archived.' });
        return;
      }
      const allowed = hasFileResourceAuthorizer(ref.resourceType) && (await checkFileResourceAccess(user, ref.resourceType, ref.resourceId, 'read'));
      if (!allowed) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'files' for this record." });
        return;
      }
    }

    const file = await getFileDownloadUrl(user.orgId, id);
    if (!file) {
      reply.status(404).send({ error: 'not_found', message: 'File not found, not yet uploaded, or archived.' });
      return;
    }
    reply.send(file);
  });

  // Archive, not hard-delete — PRD §6.4.1's convention, same as
  // knowledge.ts / goals.ts's own archive endpoints. Does not delete the
  // underlying object — see fileService.ts's archiveFile comment.
  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    if (!(await hasPermission(user, 'files', 'delete'))) {
      const ref = await getFileResourceRef(user.orgId, id);
      if (!ref) {
        reply.status(404).send({ error: 'not_found', message: 'File not found or already archived.' });
        return;
      }
      // Own-record write access, not a separate "delete" mode — the
      // same eod.ts-mirroring authorizer that lets you attach your own
      // proof file lets you retract it. There's no PRD-named case yet
      // for "can write but shouldn't be able to archive", so this
      // doesn't invent a third mode until one appears.
      const allowed = hasFileResourceAuthorizer(ref.resourceType) && (await checkFileResourceAccess(user, ref.resourceType, ref.resourceId, 'write'));
      if (!allowed) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'files' for this record." });
        return;
      }
    }

    const file = await archiveFile(user.orgId, id, user.userId);
    if (!file) {
      reply.status(404).send({ error: 'not_found', message: 'File not found or already archived.' });
      return;
    }
    reply.send(file);
  });
}
