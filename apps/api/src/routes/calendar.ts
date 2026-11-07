// PRD §10.5 CalendarService / §8.2 Calendar. Everything here is
// session-authed (mounted at /api/v1/calendar). The two unauthenticated
// calendar surfaces — Google's push webhook and the maintenance-sweep
// trigger — deliberately live in their own files (routes/calendarWebhook.ts,
// routes/calendarMaintenance.ts) with their own verification, not here.
//
// Permission shape, consistent with calendarService.ts's own doc
// comments ("own record unless a flat grant says otherwise" — same
// pattern as tasks.ts):
//  - Everyone can connect/manage their OWN Google account and see their
//    own connections/subscriptions/events — no grant needed, same as
//    anyone being able to file their own EOD.
//  - A flat `calendar.read` grant (or leader) sees every connection/
//    subscription/event across the org, for the shared-calendar case
//    (SESSION_LOG: "a shared org calendar is just a calendar ID that
//    some user's account happens to have access to").
//  - `calendar.create` / `calendar.update` / `calendar.delete` grants
//    let a non-owner manage someone else's connection's subscriptions/
//    events (e.g. a leader tidying up after someone leaves) — checked
//    per-action, mirroring eod.ts's inline own-vs-grant branch.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { hasPermission, type PermissionAction } from '../plugins/rbac.js';
import { buildCalendarConsentUrl, exchangeCalendarAuthCode } from '../services/calendarOAuthService.js';
import { requireFeature, BillingLimitError } from '../services/billingService.js';
import {
  listConnections,
  getConnectionForUser,
  upsertConnection,
  listAvailableCalendars,
  disconnectConnection,
  listSubscriptions,
  createSubscription,
  getSubscription,
  removeSubscription,
  listEventsInRange,
  createEvent,
  getEventForWriteBack,
  updateEvent,
  deleteEvent,
} from '../services/calendarService.js';
import type { SessionUser } from '../services/sessionService.js';
import type { CalendarEventInput } from '@nexus/shared';

const CALENDAR_OAUTH_STATE_COOKIE = 'nexus_calendar_oauth_state';
const isProd = process.env.NODE_ENV === 'production';

function isValidIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export async function registerCalendarRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- OAuth connect flow (per-user, offline + calendar scope — see
  // calendarOAuthService.ts's header comment for why this is a distinct
  // flow from login's) ----

  app.get('/oauth/start', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    // Session 47: calendar_sync is a starter/pro feature. Gated at the
    // OAuth entry point rather than deeper in the flow (calendarOAuthService
    // or the webhook) — no point sending someone through Google's consent
    // screen just to reject the callback.
    const user = req.sessionUser!;
    try {
      await requireFeature(user.orgId, 'calendar_sync');
    } catch (err) {
      if (err instanceof BillingLimitError) {
        reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
    const state = crypto.randomBytes(16).toString('base64url');
    reply.setCookie(CALENDAR_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 10 * 60,
      path: '/',
    });
    reply.redirect(buildCalendarConsentUrl(state));
  });

  app.get('/oauth/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = req.sessionUser!;
    const { code, state } = req.query as { code?: string; state?: string };
    const expectedState = req.cookies?.[CALENDAR_OAUTH_STATE_COOKIE];
    reply.clearCookie(CALENDAR_OAUTH_STATE_COOKIE, { path: '/' });

    if (!code || !state || !expectedState || state !== expectedState) {
      reply.status(400).send({ error: 'invalid_state', message: 'OAuth state mismatch — please retry connecting your calendar.' });
      return;
    }

    let identity;
    try {
      identity = await exchangeCalendarAuthCode(code);
    } catch (err) {
      req.log.warn({ err }, 'Calendar OAuth code exchange failed');
      reply.status(401).send({ error: 'invalid_token', message: 'Could not verify the Google account.' });
      return;
    }

    await upsertConnection(user.orgId, user.userId, identity);

    reply.redirect(`${process.env.WEB_ORIGIN ?? 'http://localhost:5173'}/work/calendar`);
  });

  // ---- Connections ----

  app.get('/connections', async (req, reply) => {
    const user = req.sessionUser!;
    const canSeeAll = await hasPermission(user, 'calendar', 'read');
    reply.send({ connections: await listConnections(user.orgId, user.userId, canSeeAll) });
  });

  app.get('/connections/:id/calendars', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const canSeeAll = await hasPermission(user, 'calendar', 'read');
    const connection = await getConnectionForUser(user.orgId, id, user.userId, canSeeAll);
    if (!connection) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar connection not found.' });
      return;
    }
    reply.send({ calendars: await listAvailableCalendars(user.orgId, connection) });
  });

  app.delete('/connections/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const canManageAll = await hasPermission(user, 'calendar', 'delete');
    const connection = await getConnectionForUser(user.orgId, id, user.userId, canManageAll);
    if (!connection) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar connection not found.' });
      return;
    }
    await disconnectConnection(user.orgId, connection);
    reply.send({ ok: true });
  });

  // ---- Subscriptions (which synced calendars) ----

  app.get('/subscriptions', async (req, reply) => {
    const user = req.sessionUser!;
    const canSeeAll = await hasPermission(user, 'calendar', 'read');
    reply.send({ subscriptions: await listSubscriptions(user.orgId, user.userId, canSeeAll) });
  });

  app.post('/subscriptions', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as { connectionId?: string; googleCalendarId?: string; calendarName?: string };
    if (!body?.connectionId || !body.googleCalendarId || !body.calendarName) {
      reply.status(400).send({ error: 'invalid_body', message: 'connectionId, googleCalendarId, and calendarName are required.' });
      return;
    }

    const canManageAll = await hasPermission(user, 'calendar', 'create');
    const connection = await getConnectionForUser(user.orgId, body.connectionId, user.userId, canManageAll);
    if (!connection) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar connection not found.' });
      return;
    }

    const subscription = await createSubscription(user.orgId, connection, body.googleCalendarId, body.calendarName, user.userId);
    reply.status(201).send(subscription);
  });

  app.delete('/subscriptions/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const sub = await getSubscription(user.orgId, id);
    if (!sub) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar subscription not found.' });
      return;
    }
    if (!(await canManageConnection(user, user.orgId, sub.connection_id, 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'calendar'." });
      return;
    }
    await removeSubscription(user.orgId, sub);
    reply.send({ ok: true });
  });

  // ---- Events (merged agenda + write-back) ----

  app.get('/events', async (req, reply) => {
    const user = req.sessionUser!;
    const q = req.query as { from?: string; to?: string };
    if (!isValidIsoDateTime(q.from) || !isValidIsoDateTime(q.to)) {
      reply.status(400).send({ error: 'invalid_query', message: 'from and to must be ISO date-times.' });
      return;
    }
    const canSeeAll = await hasPermission(user, 'calendar', 'read');
    const events = await listEventsInRange(user.orgId, user.userId, canSeeAll, q.from, q.to);
    reply.send({ events });
  });

  app.post('/events', async (req, reply) => {
    const user = req.sessionUser!;
    const body = req.body as Partial<CalendarEventInput> & { subscriptionId?: string };
    if (!body?.subscriptionId || !body.title) {
      reply.status(400).send({ error: 'invalid_body', message: 'subscriptionId and title are required.' });
      return;
    }
    if (!validEventInputShape(body)) {
      reply.status(400).send({ error: 'invalid_body', message: 'Provide either startAt/endAt or startDate/endDate, matching allDay.' });
      return;
    }

    const sub = await getSubscription(user.orgId, body.subscriptionId);
    if (!sub) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar subscription not found.' });
      return;
    }
    if (!(await canManageConnection(user, user.orgId, sub.connection_id, 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'calendar'." });
      return;
    }

    const event = await createEvent(user.orgId, sub, user.userId, body as CalendarEventInput);
    reply.status(201).send(event);
  });

  app.patch('/events/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };
    const body = req.body as Partial<CalendarEventInput>;

    const found = await getEventForWriteBack(user.orgId, id);
    if (!found) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar event not found.' });
      return;
    }
    if (!(await canManageConnection(user, user.orgId, found.subscription.connection_id, 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'calendar'." });
      return;
    }

    reply.send(await updateEvent(user.orgId, found, body));
  });

  app.delete('/events/:id', async (req, reply) => {
    const user = req.sessionUser!;
    const { id } = req.params as { id: string };

    const found = await getEventForWriteBack(user.orgId, id);
    if (!found) {
      reply.status(404).send({ error: 'not_found', message: 'Calendar event not found.' });
      return;
    }
    if (!(await canManageConnection(user, user.orgId, found.subscription.connection_id, 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'calendar'." });
      return;
    }

    await deleteEvent(user.orgId, found);
    reply.send({ ok: true });
  });
}

/** A subscription/event's underlying connection determines who "owns"
 * it. `getConnectionForUser(..., canSeeAll=true)` here means "fetch
 * regardless of ownership so we can inspect it ourselves" — not "this
 * caller may act on it"; the actual authorization decision is the
 * `hasPermission` OR `userId` check below, same two-part shape
 * `requireCalendarAccess`-style helpers use elsewhere in this codebase
 * (tasks.ts's own-record branch). */
async function canManageConnection(user: SessionUser, orgId: string, connectionId: string, action: PermissionAction): Promise<boolean> {
  if (await hasPermission(user, 'calendar', action)) return true;
  // getConnectionForUser returns the raw ConnectionRow (snake_case,
  // user_id) here — not the CalendarConnection shared type — since
  // canSeeAll=true means "fetch regardless of ownership," and this
  // function's whole job is to then read that row's actual owner back out.
  const connection = await getConnectionForUser(orgId, connectionId, user.userId, true);
  return connection?.user_id === user.userId;
}

function validEventInputShape(body: Partial<CalendarEventInput>): boolean {
  if (body.allDay) return Boolean(body.startDate && body.endDate);
  return Boolean(body.startAt && body.endAt);
}
