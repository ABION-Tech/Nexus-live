// PRD §8.9 EOD Report + §8.7 EOD compliance / §8.9 Failsafe's `eod`
// category. No dedicated Comms & Ops module exists yet (§7.1's IA
// reconciliation, O8, is still open) — this route exists at its own
// prefix now, same precedent as tasks.ts/goals.ts predating their
// modules, so Analytics Phase 2 (SESSION_LOG) has something real to call.
//
// Permission shape:
//  - POST / (submit): always allowed for your own EOD (no grant needed —
//    everyone files their own, including interns per PRD §3's role
//    table). Filing *for someone else* (the "who am I filing for"
//    selector, PRD §8.9 — a supervisor filing on an intern's behalf)
//    requires a flat `eod.create` grant, checked inline once the target
//    userId is known, mirroring tasks.ts's own-record branch.
//  - GET / (list for a date): general `eod.read` grant sees everyone's
//    log for that date; without it, scoped to the caller's own entry —
//    same fallback shape as tasks.ts's list route.
//  - GET /compliance and GET /missing: both are inherently team-wide
//    aggregates (there's no "own compliance percentage" the way there's
//    an "own task list"), so these are flat `analytics.read` checks,
//    matching goals.ts's flat-grant style rather than tasks.ts's
//    row-branching one — the same reasoning goals.ts's own comment gives
//    for why it has no `.own` case.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  getAttendanceForDate,
  getEodCompliance,
  getMissingEod,
  listEodLogsForDate,
  listEodLogsInRange,
  submitEod,
} from '../services/eodService.js';
import type { SubmitEodInput } from '@nexus/shared';

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // UTC — no per-org timezone modeled yet, see routes note
}

const clip = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 4000) : undefined);

export async function registerEodRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as Partial<SubmitEodInput>;

    if (!body?.summary || typeof body.summary !== 'string') {
      reply.status(400).send({ error: 'invalid_body', message: 'summary is required.' });
      return;
    }
    if (body.date && !isValidIsoDate(body.date)) {
      reply.status(400).send({ error: 'invalid_date', message: 'date must be an ISO date (YYYY-MM-DD).' });
      return;
    }

    const targetUserId = body.userId ?? user.userId;
    if (targetUserId !== user.userId) {
      const granted = await hasPermission(user, 'eod', 'create');
      if (!granted) {
        reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'eod' to file for another user." });
        return;
      }
    }

    const log = await submitEod(user.orgId, user.userId, {
      userId: targetUserId,
      date: body.date ?? today(),
      summary: body.summary,
      movedForward: clip(body.movedForward),
      keyAchievement: clip(body.keyAchievement),
      blockers: clip(body.blockers),
      tomorrowPlan: clip(body.tomorrowPlan),
    });
    reply.status(201).send(log);
  });

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { date?: string };
    const date = q.date ?? today();
    if (!isValidIsoDate(date)) {
      reply.status(400).send({ error: 'invalid_date', message: 'date must be an ISO date (YYYY-MM-DD).' });
      return;
    }

    const canReadAll = await hasPermission(user, 'eod', 'read');
    const logs = await listEodLogsForDate(user.orgId, date);
    const scoped = canReadAll ? logs : logs.filter((l) => l.userId === user.userId);
    reply.send({ logs: scoped });
  });

  // Session 58 — Activity Log: EOD history. Leaders (eod.read) see
  // everyone's; anyone else sees their own.
  app.get('/history', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { from?: string; to?: string; userId?: string };
    const to = q.to ?? today();
    const from = q.from ?? new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
      reply.status(400).send({ error: 'invalid_date', message: 'from and to must be ISO dates (YYYY-MM-DD).' });
      return;
    }
    const canReadAll = await hasPermission(user, 'eod', 'read');
    const who = canReadAll ? q.userId : user.userId;
    reply.send({ from, to, logs: await listEodLogsInRange(user.orgId, from, to, who) });
  });

  app.get('/compliance', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'analytics', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'analytics'." });
      return;
    }
    const q = req.query as { date?: string };
    const date = q.date ?? today();
    if (!isValidIsoDate(date)) {
      reply.status(400).send({ error: 'invalid_date', message: 'date must be an ISO date (YYYY-MM-DD).' });
      return;
    }
    const summary = await getEodCompliance(user.orgId, date);
    reply.send(summary);
  });

  app.get('/missing', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'analytics', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'analytics'." });
      return;
    }
    const q = req.query as { date?: string };
    const date = q.date ?? today();
    if (!isValidIsoDate(date)) {
      reply.status(400).send({ error: 'invalid_date', message: 'date must be an ISO date (YYYY-MM-DD).' });
      return;
    }
    const users = await getMissingEod(user.orgId, date);
    reply.send({ users });
  });

  // People > Attendance (PRD §8.4). Same flat 'analytics.read' gate as
  // /compliance and /missing above — an aggregate/team-wide view, not
  // something with an own-record fallback.
  app.get('/attendance', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'analytics', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'analytics'." });
      return;
    }
    const q = req.query as { date?: string };
    const date = q.date ?? today();
    if (!isValidIsoDate(date)) {
      reply.status(400).send({ error: 'invalid_date', message: 'date must be an ISO date (YYYY-MM-DD).' });
      return;
    }
    const entries = await getAttendanceForDate(user.orgId, date);
    reply.send({ entries });
  });
}
