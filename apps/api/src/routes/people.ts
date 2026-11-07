// PRD §8.4 People/team-members — a single read endpoint, deliberately not
// a full CRUD module: adding/removing team members already happens via
// the invite flow (routes/invites.ts), and there's no product requirement
// yet for anything else here. This exists purely to unblock the Network
// frontend's assignee/owner pickers (Partnerships.tsx / OrgDatabase.tsx),
// per Session 15's own next-steps note and rbac.ts's comment flagging
// People as the missing piece before check 4's route-layer pattern could
// be fully exercised end to end.
//
// requireAuth only, no resource-level permission gate: every org member
// needs to see the teammate list to assign work to someone, the same way
// the MVP's getTeamEmailMap()/getAllTeamNames() were available to anyone
// signed in, not leader-gated. Nothing sensitive is exposed — name, email,
// role — the same fields already visible via /invites and task assignee
// display elsewhere in the app.
import type { FastifyInstance } from 'fastify';
import { listOrgPeople } from '../services/peopleService.js';

export async function registerPeopleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const people = await listOrgPeople(user.orgId);
    reply.send({ people });
  });
}
