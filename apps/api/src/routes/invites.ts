// PRD §3 invite-and-approval flow — the leader-facing half.
// `inviteService.ts` (built in an earlier session) has been fully
// tested via `acceptInvite`'s caller in `routes/auth.ts`, but until now
// nothing let a leader actually create or revoke an invite over HTTP;
// the only way to get a row into `invites` was a manual SQL insert.
// This file is that missing caller — no new service logic, just routes
// over what already exists.
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/rbac.js';
import { createInvite, revokeInvite, listPendingInvites, InviteError } from '../services/inviteService.js';
import { checkSeatLimit, BillingLimitError } from '../services/billingService.js';
import { sendInviteEmail, getUserDisplayName } from '../services/emailService.js';
import type { Role } from '@nexus/shared';

const VALID_ROLES: Role[] = ['leader', 'team_member', 'intern'];

// Rough shape check, not full RFC 5322 validation — the real
// verification that an email is reachable and correct is the invitee
// actually completing Google OAuth with it (routes/auth.ts). This just
// catches obvious typos before a leader burns an invite slot on one.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerInviteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Gated on the `users` resource, not `invites` — an invite is how a
  // new `users` row gets created (PRD §3: the invite itself is the
  // approval step), so it's the same permission a leader would need to
  // manage the Team Members directory (PRD §8.4), not a separate
  // resource to grant independently.
  app.post('/', { preHandler: requirePermission('users', 'create') }, async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as { email?: string; role?: string };

    if (!body?.email || typeof body.email !== 'string' || !EMAIL_SHAPE.test(body.email.trim())) {
      reply.status(400).send({ error: 'invalid_body', message: 'A valid email is required.' });
      return;
    }
    if (!body.role || !VALID_ROLES.includes(body.role as Role)) {
      reply.status(400).send({ error: 'invalid_body', message: `role must be one of ${VALID_ROLES.join(', ')}` });
      return;
    }
    // Session 53: closes a privilege-escalation path. `users:create` can be
    // granted to a non-leader, and without this check that person could
    // invite a brand-new account straight in as a leader. Only a leader
    // may create another leader.
    if (body.role === 'leader' && user.role !== 'leader') {
      reply.status(403).send({ error: 'forbidden', message: 'Only a leader can invite someone as a leader.' });
      return;
    }

    try {
      // Session 47: a soft pre-check at invite-creation time (open
      // question #2 — every membership role, including this invite's
      // eventual one, counts as a seat) so a leader isn't allowed to
      // send an invite that's already over the seat cap today. The
      // authoritative check is at acceptance (routes/auth.ts's
      // acceptInvite call site) — org_memberships doesn't actually grow
      // until then, and several outstanding invites can still land at
      // once, so this alone can't be the only gate.
      await checkSeatLimit(user.orgId);
      const invite = await createInvite({
        orgId: user.orgId,
        email: body.email,
        role: body.role as Role,
        invitedBy: user.userId,
      });
      // Best-effort, same posture as guests.ts's recomputeSeatCount call:
      // the invite row is already real and visible on the Team Members
      // screen regardless, so a flaky email provider doesn't get to turn
      // an otherwise-successful invite into a failed request (closes
      // NEXUS_LAUNCH_CHECKLIST.md P0 #2's "the leader has to manually
      // copy/share the invite link" gap without introducing a new one).
      getUserDisplayName(user.orgId, user.userId)
        .then((invitedByName) => sendInviteEmail(invite, invitedByName))
        .catch((err) => req.log.warn({ err, inviteId: invite.id }, 'Failed to send invite email'));

      reply.status(201).send(invite);
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof InviteError) {
        // createInvite only ever throws 'conflict' (a live invite already
        // exists) or 'already_member' (Session 57: they're already in this
        // company). Both are 409s. Someone with an account in another
        // company is no longer an error: they get an invitation in-app.
        reply.status(409).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });

  // Session 53 — pending invites for this org (Settings > Team & Roles).
  app.get('/', { preHandler: requirePermission('users', 'create') }, async (req, reply) => {
    const user = req.sessionUser!;
    const invites = await listPendingInvites(user.orgId);
    reply.send({ invites });
  });

  app.delete('/:id', { preHandler: requirePermission('users', 'delete') }, async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    try {
      await revokeInvite(user.orgId, id);
      reply.status(204).send();
    } catch (err) {
      if (err instanceof InviteError) {
        reply.status(404).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
