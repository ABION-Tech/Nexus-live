// ADMIN_BUILD_GUIDE.md §1 (repo Session 37): "Company (any admin tier)
// generates guest credentials and shares them." Company Admin = the
// existing `leader` role (locked decision, §1 table) — gated the same
// direct `role === 'leader'` way TeamRoles.tsx's own `canManage` already
// does client-side, not a `permissions` table grant, since guest
// provisioning is an org-admin action in the same class as inviting a
// team member (routes/invites.ts), not a resource+action grant.
//
// The guest-invite *surface* (a page in Settings) is Session 41/42 per
// the guide's own numbering — this is the backend half only, mirroring
// how invites.ts's HTTP routes predate any dedicated invite-management
// UI screen.
import type { FastifyInstance } from 'fastify';
import { createGuestCredential, GuestServiceError } from '../services/guestService.js';
import { checkSeatLimit, recomputeSeatCount, requireFeature, BillingLimitError } from '../services/billingService.js';
import { sendGuestCredentialEmail } from '../services/emailService.js';

export async function registerGuestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (user.role !== 'leader') {
      reply.status(403).send({ error: 'forbidden', message: 'Only a leader can create guest credentials.' });
      return;
    }

    const body = req.body as { name?: string; email?: string };
    if (!body?.name || !body?.email) {
      reply.status(400).send({ error: 'invalid_body', message: 'name and email are required.' });
      return;
    }

    try {
      // Session 47: absorbed here rather than deferred (see 0025_billing.sql's
      // header, open question #1) — a guest credential is a real seat
      // (open question #2: every org_memberships role counts, guests
      // included) AND guest_invites itself is a starter/pro-gated
      // feature, so both checks apply, same "feature gate first, then
      // capacity" order requireFeature-then-checkSeatLimit already
      // establishes elsewhere in this file's sibling routes.
      await requireFeature(user.orgId, 'guest_invites');
      await checkSeatLimit(user.orgId);
      const credential = await createGuestCredential(user.orgId, body.name, body.email);
      // Authoritative seat-count refresh point for this write path, same
      // best-effort posture as auth.ts's own call after invite
      // acceptance — org_memberships actually grows above; a stale
      // cached count is a smaller problem than blocking credential
      // creation on it.
      recomputeSeatCount(user.orgId).catch((err) => req.log.warn({ err, orgId: user.orgId }, 'Failed to recompute seat count after guest creation'));
      // Best-effort, same posture as the seat-count refresh above and
      // invites.ts's own email send: NEXUS_LAUNCH_CHECKLIST.md P0 #2 also
      // flags guest credential creation as a "nobody gets told" gap. The
      // leader still gets tempPassword back synchronously below either
      // way, so a failed send here is a missed convenience, not a lost
      // credential.
      sendGuestCredentialEmail(user.orgId, credential).catch((err) =>
        req.log.warn({ err, userId: credential.userId }, 'Failed to send guest credential email')
      );
      // tempPassword is returned exactly once, in this response — not
      // stored anywhere retrievable afterward (guestService only ever
      // persists its hash). The leader is responsible for sharing it
      // with the guest out of band.
      reply.status(201).send(credential);
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof GuestServiceError) {
        reply.status(409).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
  });
}
