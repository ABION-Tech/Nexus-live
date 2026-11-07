// One-off seed for the click-through verification that's been on the
// next-steps list since Session 17 ("needs an actual running apps/api
// against a real or local Postgres + apps/web dev server, leader vs.
// own-record-only team member pass"). This environment has no browser,
// so the "web dev server" half is still out of reach — but the API half
// (real Postgres, real RLS, real sessions via createSession, not the
// mocked sessionService from network.test.ts) is fully doable and is a
// strictly stronger check than the route-level mock suite from Session
// 18: this exercises the actual `withOrgContext` + RLS policies, which
// Session 18 explicitly flagged as still unverified.
//
// Not a permanent fixture — prints tokens to stdout for manual curl use,
// then exits. Re-run against a fresh DB if the seeded IDs are needed
// again; nothing here is idempotent on purpose (it's throwaway).
import 'dotenv/config';
import { pool, withOrgContext } from '../db.js';
import { createSession } from '../services/sessionService.js';

async function main() {
  // Session 9 hardening pass fix: this used to be a raw `insert into
  // organizations` — which only ever "worked" because DATABASE_URL
  // pointed at a superuser/BYPASSRLS role at the time this script was
  // written, contrary to this file's own header comment claiming "real
  // RLS" was exercised here. Under the corrected nexus_app role (see
  // .env.example / DEPLOYMENT.md, same pass), a raw insert with no
  // app.current_org_id set correctly fails closed — there's no
  // "org doesn't exist yet" exemption for a brand-new tenant row, by
  // design. create_organization_row() is the actual RLS-safe path
  // (0020_organizations_platform_writes.sql, nexus_bootstrap-owned
  // SECURITY DEFINER, granted to nexus_app) — organizationService.ts's
  // own createOrganization already routes through it for exactly this
  // reason; this script now does the same instead of a shortcut that
  // only ever worked by accident.
  const orgRes = await pool.query<{ id: string }>(
    `select id from create_organization_row($1, $2, $3)`,
    ['ABION Test Org', 'company', null]
  );
  const orgRow = orgRes.rows[0];
  if (!orgRow) throw new Error('organizations insert returned no row');
  const orgId = orgRow.id;

  // Session 9 hardening pass fix: everything below this point writes to
  // real tenant tables (users, org_memberships, partnerships,
  // org_contacts, task_trends) — all RLS-force-enabled, all keyed on
  // `org_id = current_setting('app.current_org_id')`. The raw `pool`
  // has no such setting, so under the corrected nexus_app role every
  // one of these would fail closed exactly like the organizations
  // insert above did, for the same reason. withOrgContext(orgId, ...)
  // is the actual, real request path every route in this codebase uses
  // for tenant writes — using it here too is what makes this script's
  // own header comment ("real RLS... which Session 18 explicitly
  // flagged as still unverified") actually true instead of aspirational.
  // Session 9 hardening pass fix (second layer): `makeUser` used to call
  // `createSession` here too, on the raw `pool` (a separate connection)
  // from inside this still-open `withOrgContext` transaction. That's a
  // real bug, not just an RLS one: the new user row isn't visible to
  // any other connection until this transaction commits, so `sessions`'
  // `sessions_user_id_fkey` correctly rejected it — "Key (user_id)=(...)
  // is not present in table users" — every time, once the RLS fixes
  // above stopped masking it with an earlier failure. Confirmed by
  // checking every real call site: routes/auth.ts and routes/devAuth.ts
  // both call `createSession` after their org-context work has already
  // resolved, never from inside it — this script now matches that same
  // safe ordering instead of the pattern that only "worked" before
  // because the org insert failed first. `makeUser` now only returns
  // the new user's id/role; sessions are created below, after
  // `withOrgContext` (and its `COMMIT`) has returned.
  const seeded = await withOrgContext(orgId, async (client) => {
    async function makeUser(name: string, email: string, role: 'leader' | 'team_member') {
      const userRes = await client.query<{ id: string }>(
        `insert into users (name, email, home_org_id) values ($1, $2, $3) returning id`,
        [name, email, orgId]
      );
      const userRow = userRes.rows[0];
      if (!userRow) throw new Error('users insert returned no row');
      const userId = userRow.id;
      await client.query(
        `insert into org_memberships (user_id, org_id, role, is_home) values ($1, $2, $3, true)`,
        [userId, orgId, role]
      );
      return { userId };
    }

    const leader = await makeUser('Ayo Leader', 'ayo@abion.test', 'leader');
    const owner = await makeUser('Owner TeamMember', 'owner@abion.test', 'team_member');
    const other = await makeUser('Other TeamMember', 'other@abion.test', 'team_member');

    const ptnRes = await client.query<{ id: string }>(
      `insert into partnerships (org_id, assigned_to_user_id, organisation, current_status, document_status)
       values ($1, $2, 'Acme Foundation', 'in_discussion', 'not_started') returning id`,
      [orgId, owner.userId]
    );
    const ptnRow = ptnRes.rows[0];
    if (!ptnRow) throw new Error('partnerships insert returned no row');

    const contactRes = await client.query<{ id: string }>(
      `insert into org_contacts (org_id, contact_owner_user_id, visitor_name, letter_status, onboarding_status)
       values ($1, $2, 'Jane Visitor', 'not_sent', 'pending') returning id`,
      [orgId, owner.userId]
    );
    const contactRow = contactRes.rows[0];
    if (!contactRow) throw new Error('org_contacts insert returned no row');

    // Org-wide (user_id null) task_trends snapshots — 14 days, so the
    // Analytics page's TaskTrendsChart has something real to render
    // instead of the "no trend data yet" empty state on a freshly seeded
    // DB. Numbers are synthetic but shaped like a plausible week (open
    // count drifting, overdue/at-risk noisy, done-today weekday-ish).
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayOfWeek = d.getDay(); // 0 = Sunday
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const openTasks = 18 + Math.round(Math.sin(i / 2) * 4) + (13 - i);
      const doneToday = isWeekend ? Math.round(Math.random() * 1) : 2 + Math.round(Math.random() * 4);
      const overdue = Math.max(0, Math.round(2 + Math.sin(i / 3) * 2));
      const atRisk = Math.max(0, Math.round(3 + Math.cos(i / 2.5) * 2));
      await client.query(
        `insert into task_trends (org_id, date, user_id, open_tasks, done_today, overdue, at_risk)
         values ($1, $2, null, $3, $4, $5, $6)`,
        [orgId, dateStr, openTasks, doneToday, overdue, atRisk]
      );
    }

    return { leader, owner, other, ptnRow, contactRow };
  });
  const { leader, owner, other, ptnRow, contactRow } = seeded;

  // Sessions created here, after withOrgContext's COMMIT has returned —
  // see the comment above. createSession itself still writes to
  // `sessions` via the raw pool by design (db.ts's own doctrine —
  // sessions predates org context, see that file's header comment); the
  // fix was ordering (after commit), not which connection it uses.
  const leaderSession = await createSession(leader.userId, orgId);
  const ownerSession = await createSession(owner.userId, orgId);
  const otherSession = await createSession(other.userId, orgId);

  console.log(JSON.stringify(
    {
      orgId,
      leader: { userId: leader.userId, token: leaderSession.token },
      owner: { userId: owner.userId, token: ownerSession.token },
      other: { userId: other.userId, token: otherSession.token },
      partnershipId: ptnRow.id,
      orgContactId: contactRow.id,
      taskTrendDays: 14,
    },
    null,
    2
  ));

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
