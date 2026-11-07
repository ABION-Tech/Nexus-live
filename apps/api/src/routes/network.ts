// PRD §8.3 Network domain routes — one file backing the three
// consolidated MVP tabs, same reasoning as networkService.ts.
//
// Permission shape differs per table, matching each one's real ownership
// model (see 0008_network.sql's comments):
//  - /cos: flat `network.cos` grant only — no per-row owner exists to
//    branch on, same shape as goals.ts.
//  - /partnerships, /org-contacts: flat `network.partnerships` /
//    `network.org` grant OR the row's own assignee/owner, same
//    load-then-decide shape as tasks.ts (a preHandler can't know "is this
//    row yours" before the row is loaded).
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  archivePartnership,
  createNetworkCos,
  createOrgContact,
  createPartnership,
  getNetworkCosById,
  getOrgContactById,
  getPartnershipById,
  isOwnOrgContact,
  isOwnPartnership,
  listNetworkCos,
  listOrgContacts,
  listPartnerships,
  updateNetworkCos,
  updateOrgContact,
  updatePartnership,
  type CosInput,
  type OrgContactInput,
  type PartnershipInput,
} from '../services/networkService.js';

const COS_STATUSES = ['not_started', 'acknowledged', 'in_progress', 'follow_up_needed', 'active'];
const PARTNERSHIP_STATUSES = ['not_started', 'in_discussion', 'negotiating', 'cold', 'active', 'declined'];
const DOCUMENT_STATUSES = ['not_started', 'draft_sent', 'under_review', 'signed', 'na'];
const LETTER_STATUSES = ['not_sent', 'sent', 'acknowledged'];
const ONBOARDING_STATUSES = ['pending', 'in_progress', 'active', 'declined'];

export async function registerNetworkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ─── COS ─────────────────────────────────────────────────────────
  app.get('/cos', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'network.cos', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'network.cos'." });
      return;
    }
    const q = req.query as { includeArchived?: string };
    const rows = await listNetworkCos(user.orgId, q.includeArchived === 'true');
    reply.send({ cos: rows });
  });

  app.get('/cos/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'network.cos', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'network.cos'." });
      return;
    }
    const { id } = req.params as { id: string };
    const row = await getNetworkCosById(user.orgId, id);
    if (!row) {
      reply.status(404).send({ error: 'not_found', message: 'COS record not found.' });
      return;
    }
    reply.send(row);
  });

  app.post('/cos', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'network.cos', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'network.cos'." });
      return;
    }
    const body = req.body as Partial<CosInput>;
    if (!body?.state || typeof body.state !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'state is required.' });
      return;
    }
    if (body.status && !COS_STATUSES.includes(body.status)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${COS_STATUSES.join(', ')}` });
      return;
    }
    const row = await createNetworkCos(user.orgId, body as CosInput);
    reply.status(201).send(row);
  });

  app.patch('/cos/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'network.cos', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'network.cos'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as Partial<CosInput>;
    if (body.status && !COS_STATUSES.includes(body.status)) {
      reply.status(400).send({ error: 'invalid_status', message: `status must be one of ${COS_STATUSES.join(', ')}` });
      return;
    }
    const row = await updateNetworkCos(user.orgId, id, body);
    if (!row) {
      reply.status(404).send({ error: 'not_found', message: 'COS record not found or archived.' });
      return;
    }
    reply.send(row);
  });

  // ─── Partnerships ────────────────────────────────────────────────
  app.get('/partnerships', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { assignedToUserId?: string; includeArchived?: string };
    const canReadAll = await hasPermission(user, 'network.partnerships', 'read');
    let assignedToUserId = q.assignedToUserId;
    if (!canReadAll) {
      if (assignedToUserId && assignedToUserId !== user.userId) {
        reply.status(403).send({ error: 'forbidden', message: 'Can only list partnerships assigned to you.' });
        return;
      }
      assignedToUserId = user.userId;
    }
    const rows = await listPartnerships(user.orgId, { assignedToUserId, includeArchived: q.includeArchived === 'true' });
    reply.send({ partnerships: rows });
  });

  app.get('/partnerships/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const row = await getPartnershipById(user.orgId, id);
    if (!row) {
      reply.status(404).send({ error: 'not_found', message: 'Partnership not found.' });
      return;
    }
    const allowed = (await hasPermission(user, 'network.partnerships', 'read')) || isOwnPartnership(row, user.userId);
    if (!allowed) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'network.partnerships'." });
      return;
    }
    reply.send(row);
  });

  app.post('/partnerships', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'network.partnerships', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'network.partnerships'." });
      return;
    }
    const body = req.body as Partial<PartnershipInput>;
    if (!body?.organisation || typeof body.organisation !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'organisation is required.' });
      return;
    }
    if (body.currentStatus && !PARTNERSHIP_STATUSES.includes(body.currentStatus)) {
      reply.status(400).send({ error: 'invalid_status', message: `currentStatus must be one of ${PARTNERSHIP_STATUSES.join(', ')}` });
      return;
    }
    if (body.documentStatus && !DOCUMENT_STATUSES.includes(body.documentStatus)) {
      reply.status(400).send({ error: 'invalid_document_status', message: `documentStatus must be one of ${DOCUMENT_STATUSES.join(', ')}` });
      return;
    }
    const row = await createPartnership(user.orgId, body as PartnershipInput);
    reply.status(201).send(row);
  });

  app.patch('/partnerships/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const existing = await getPartnershipById(user.orgId, id);
    if (!existing) {
      reply.status(404).send({ error: 'not_found', message: 'Partnership not found.' });
      return;
    }
    const canUpdateAll = await hasPermission(user, 'network.partnerships', 'update');
    const own = isOwnPartnership(existing, user.userId);
    if (!canUpdateAll && !own) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'network.partnerships'." });
      return;
    }
    const body = req.body as Partial<PartnershipInput>;
    if (body.currentStatus && !PARTNERSHIP_STATUSES.includes(body.currentStatus)) {
      reply.status(400).send({ error: 'invalid_status', message: `currentStatus must be one of ${PARTNERSHIP_STATUSES.join(', ')}` });
      return;
    }
    if (body.documentStatus && !DOCUMENT_STATUSES.includes(body.documentStatus)) {
      // Document Status is a leader-only field in the MVP (enforceLeaderOnlyFields,
      // TAB_LEADER_ONLY_FIELDS['3. Partnerships']) — an own-record caller
      // updating it at all, valid value or not, isn't allowed to touch it.
      reply.status(400).send({ error: 'invalid_document_status', message: `documentStatus must be one of ${DOCUMENT_STATUSES.join(', ')}` });
      return;
    }
    let input = body;
    if (!canUpdateAll && own) {
      // Mirrors the MVP's enforceLeaderOnlyFields for '3. Partnerships':
      // Assigned To (assignedToUserId) and Document Status are leader-only
      // fields — an own-record caller may update everything else.
      const { assignedToUserId, documentStatus, ...rest } = body;
      input = rest;
    }
    const row = await updatePartnership(user.orgId, id, input);
    reply.send(row);
  });

  app.delete('/partnerships/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const existing = await getPartnershipById(user.orgId, id);
    if (!existing) {
      reply.status(404).send({ error: 'not_found', message: 'Partnership not found.' });
      return;
    }
    const granted = (await hasPermission(user, 'network.partnerships', 'delete')) || isOwnPartnership(existing, user.userId);
    if (!granted) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'network.partnerships'." });
      return;
    }
    const archived = await archivePartnership(user.orgId, id);
    reply.send(archived);
  });

  // ─── Org Contacts ────────────────────────────────────────────────
  app.get('/org-contacts', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { contactOwnerUserId?: string; includeArchived?: string };
    const canReadAll = await hasPermission(user, 'network.org', 'read');
    let contactOwnerUserId = q.contactOwnerUserId;
    if (!canReadAll) {
      if (contactOwnerUserId && contactOwnerUserId !== user.userId) {
        reply.status(403).send({ error: 'forbidden', message: 'Can only list contacts you own.' });
        return;
      }
      contactOwnerUserId = user.userId;
    }
    const rows = await listOrgContacts(user.orgId, { contactOwnerUserId, includeArchived: q.includeArchived === 'true' });
    reply.send({ contacts: rows });
  });

  app.get('/org-contacts/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const row = await getOrgContactById(user.orgId, id);
    if (!row) {
      reply.status(404).send({ error: 'not_found', message: 'Org contact not found.' });
      return;
    }
    const allowed = (await hasPermission(user, 'network.org', 'read')) || isOwnOrgContact(row, user.userId);
    if (!allowed) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'network.org'." });
      return;
    }
    reply.send(row);
  });

  app.post('/org-contacts', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'network.org', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'network.org'." });
      return;
    }
    const body = req.body as Partial<OrgContactInput>;
    if (!body?.visitorName || typeof body.visitorName !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'visitorName is required.' });
      return;
    }
    if (body.letterStatus && !LETTER_STATUSES.includes(body.letterStatus)) {
      reply.status(400).send({ error: 'invalid_letter_status', message: `letterStatus must be one of ${LETTER_STATUSES.join(', ')}` });
      return;
    }
    if (body.onboardingStatus && !ONBOARDING_STATUSES.includes(body.onboardingStatus)) {
      reply.status(400).send({ error: 'invalid_onboarding_status', message: `onboardingStatus must be one of ${ONBOARDING_STATUSES.join(', ')}` });
      return;
    }
    const row = await createOrgContact(user.orgId, body as OrgContactInput);
    reply.status(201).send(row);
  });

  app.patch('/org-contacts/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const existing = await getOrgContactById(user.orgId, id);
    if (!existing) {
      reply.status(404).send({ error: 'not_found', message: 'Org contact not found.' });
      return;
    }
    const canUpdateAll = await hasPermission(user, 'network.org', 'update');
    const own = isOwnOrgContact(existing, user.userId);
    if (!canUpdateAll && !own) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'network.org'." });
      return;
    }
    const body = req.body as Partial<OrgContactInput>;
    if (body.letterStatus && !LETTER_STATUSES.includes(body.letterStatus)) {
      reply.status(400).send({ error: 'invalid_letter_status', message: `letterStatus must be one of ${LETTER_STATUSES.join(', ')}` });
      return;
    }
    if (body.onboardingStatus && !ONBOARDING_STATUSES.includes(body.onboardingStatus)) {
      reply.status(400).send({ error: 'invalid_onboarding_status', message: `onboardingStatus must be one of ${ONBOARDING_STATUSES.join(', ')}` });
      return;
    }
    const row = await updateOrgContact(user.orgId, id, body);
    reply.send(row);
  });
}
