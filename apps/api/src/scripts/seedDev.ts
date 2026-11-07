// The permanent local-development seed. Unlike seedClickthrough.ts (a
// throwaway, deliberately-non-idempotent RLS smoke test — see that
// file's own header), this is meant to be re-run every time a developer
// resets their local Postgres:
//
//   npm run migrate -w apps/api
//   npm run seed:dev -w apps/api
//   npm run dev:api
//   npm run dev:web
//
// It builds a realistic ABION-shaped org tree (one Group, two Companies
// under it), a Platform Admin, a Company Admin/Leader per company, a
// handful of Team Members with a couple of real per-resource permission
// grants (PRD §13.3), and enough operational data — tasks across every
// status/priority, a Goal with pending Review Queue items, network
// records, a Knowledge Base entry, EOD logs, and a 14-day Task Trends
// history — that every dashboard has something real to render instead
// of an empty state.
//
// The dev roster picker (routes/devAuth.ts's GET /roster) reads off
// org_memberships/users via list_users_for_dev_login() (0010) — nothing
// in this script needs to separately register anyone with it. It's
// populated for free by the org_memberships rows created below.
//
// Assumes a fresh DB (post-migrate, pre-seed) — same as the workflow
// above implies. It does not check for or clean up a prior run; running
// it twice creates a second, differently-named Group with duplicate
// email addresses. Reset the DB (drop/recreate + re-migrate) rather
// than re-running this against existing data. (A first-orgs pre-check
// isn't reliable here for the same reason organizationService.ts's own
// comments call out: querying `organizations` on the raw pool ahead of
// any withOrgContext always sees zero rows under RLS, so it can't tell
// "seed already ran" from "fresh DB" without its own bootstrap-function
// carve-out — not worth adding for a dev-only script.)
//
// Org creation goes through create_organization_row() (0020), the same
// nexus_bootstrap-owned SECURITY DEFINER path organizationService.ts's
// own createOrganization uses — not a raw insert. organizationService's
// createOrganization itself isn't reusable here: it requires the caller
// to already be a platform admin (isPlatformAdmin check), which is
// exactly the chicken-and-egg problem this script starts from — nobody
// is a platform admin yet on a fresh DB. Everything downstream of the
// three orgs (users, permissions, tasks, ...) goes through the same
// withOrgContext + real service functions (createTask, grantPermission,
// createGoal) every actual route uses, so this exercises real RLS the
// same way seedClickthrough.ts's own header describes.
import 'dotenv/config';
import { pool, withOrgContext } from '../db.js';
import type { PoolClient } from 'pg';
import { createSession } from '../services/sessionService.js';
import { createTask } from '../services/taskService.js';
import { createGoal } from '../services/goalService.js';
import { grantPermission } from '../services/permissionService.js';
import type { OrgType, TaskPriority, TaskStatus } from '@nexus/shared';

interface SeededOrg {
  id: string;
  name: string;
}

interface SeededUser {
  id: string;
  name: string;
  email: string;
  role: 'leader' | 'team_member' | 'intern';
}

// ---------------------------------------------------------------------
// Org + user creation helpers
// ---------------------------------------------------------------------

async function createOrg(name: string, orgType: OrgType, parentOrgId: string | null): Promise<SeededOrg> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `select id, name from create_organization_row($1, $2, $3)`,
    [name, orgType, parentOrgId]
  );
  const row = rows[0];
  if (!row) throw new Error(`create_organization_row returned no row for "${name}"`);
  return row;
}

/** Must run inside withOrgContext(orgId, ...) — home_org_id on the new
 * user row has to match app.current_org_id or the INSERT fails closed
 * under 0027_fix_users_insert_rls.sql's tenant_isolation_insert policy.
 * Same insert-then-membership order as inviteService.acceptInvite and
 * seedClickthrough.ts's own makeUser — the established safe pattern,
 * not a shortcut invented for this script. */
async function makeUser(
  client: PoolClient,
  orgId: string,
  input: { name: string; email: string; role: 'leader' | 'team_member' | 'intern'; title?: string }
): Promise<SeededUser> {
  const { rows: userRows } = await client.query<{ id: string }>(
    `insert into users (name, email, home_org_id) values ($1, $2, $3) returning id`,
    [input.name, input.email, orgId]
  );
  const userId = userRows[0]?.id;
  if (!userId) throw new Error(`users insert returned no row for "${input.email}"`);

  await client.query(
    `insert into org_memberships (user_id, org_id, role, title, is_home) values ($1, $2, $3, $4, true)`,
    [userId, orgId, input.role, input.title ?? null]
  );

  return { id: userId, name: input.name, email: input.email, role: input.role };
}

// ---------------------------------------------------------------------
// Operational data — enough per company that Dashboard, Work, Goals,
// Network, Knowledge, and Analytics all have real rows to render.
// ---------------------------------------------------------------------

interface CompanySeed {
  org: SeededOrg;
  leaderId: string;
  members: SeededUser[]; // team_member + intern rows, at least one
}

async function seedOperationalData(seed: CompanySeed): Promise<void> {
  const { org, leaderId, members } = seed;
  const primaryMember = members[0]!.id;
  const secondaryMember = members[1]?.id ?? primaryMember;

  // Tasks across every status and priority (0033_task_priority.sql) —
  // Dashboard/Work/Analytics/Failsafe all key off this spread.
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const taskSpecs: Array<{
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignedToUserId: string;
    deadline?: string;
  }> = [
    {
      title: 'Finalize Q1 partner outreach list',
      status: 'not_started',
      priority: 'high',
      assignedToUserId: primaryMember,
      deadline: new Date(now + 5 * day).toISOString(),
    },
    {
      title: 'Ship weekly ops digest template',
      status: 'in_progress',
      priority: 'medium',
      assignedToUserId: primaryMember,
      deadline: new Date(now + 2 * day).toISOString(),
    },
    {
      title: 'Resolve warehouse access blocker',
      status: 'blocked',
      priority: 'urgent',
      assignedToUserId: secondaryMember,
      // Overdue by 2 days — exercises runFollowUpEscalation's 12h-urgent
      // tier (automationJobs.ts) and getBlockedTasks (Failsafe).
      deadline: new Date(now - 2 * day).toISOString(),
    },
    {
      title: 'Deadline heads-up candidate',
      status: 'not_started',
      priority: 'high',
      assignedToUserId: secondaryMember,
      // Within 48h — exercises the "deadline_soon" heads-up branch.
      deadline: new Date(now + 1 * day).toISOString(),
    },
    {
      title: 'Archive completed onboarding checklist',
      status: 'done',
      priority: 'low',
      assignedToUserId: primaryMember,
    },
  ];

  for (const spec of taskSpecs) {
    await createTask(
      org.id,
      {
        title: spec.title,
        status: spec.status,
        priority: spec.priority,
        assignedToUserId: spec.assignedToUserId,
        supervisorUserId: leaderId,
        deadline: spec.deadline,
        business: org.name,
      },
      leaderId
    );
  }

  // Goal + pending Review Queue items (PRD §8.5) — createGoal's own
  // proposedTasks path (goalService.ts) inserts the pending_ai_tasks
  // rows in the same transaction, dependency-linked exactly like a real
  // AI decomposition response would be. Left 'pending' on purpose so
  // Review Queue has something to approve/reject against, not
  // pre-approved sample tasks.
  await createGoal(org.id, {
    title: `${org.name.split(' ')[1] ?? org.name} — Q1 Regional Expansion`,
    createdByUserId: leaderId,
    proposedTasks: [
      { title: 'Map target states for expansion', reasoning: 'Establishes scope before any outreach begins.' },
      {
        title: 'Draft partner outreach templates',
        reasoning: 'Needed once target states are known.',
        dependsOnIndex: 0,
      },
      { title: 'Recruit two regional coordinators', reasoning: 'Parallel track — not blocked on outreach.' },
    ],
  });

  await withOrgContext(org.id, async (client) => {
    // Knowledge Base (PRD §8.6) — buildKnowledgeContext_ concatenates
    // every entry into AI prompts, so at least one real entry matters
    // beyond just having something to browse.
    await client.query(
      `insert into knowledge_entries (org_id, title, content, category, updated_by_user_id)
       values ($1, $2, $3, $4, $5)`,
      [
        org.id,
        `${org.name} — Standard Operating Notes`,
        'Weekly leadership sync is Monday 9am. All partner correspondence goes through the ops inbox, not personal email. Escalate anything overdue more than 48h directly to the supervisor.',
        'Operations',
        leaderId,
      ]
    );

    // Network (PRD §8.3) — one row per subsection so RelationshipTable
    // has real data in all three tabs, not just one.
    await client.query(
      `insert into network_cos (org_id, state, admin_name, admin_phone, status)
       values ($1, 'Lagos', 'State Admin Contact', '+234-800-000-0000', 'in_progress')`,
      [org.id]
    );
    await client.query(
      `insert into partnerships (org_id, assigned_to_user_id, organisation, current_status, document_status)
       values ($1, $2, 'Northbridge Foundation', 'in_discussion', 'draft_sent')`,
      [org.id, primaryMember]
    );
    await client.query(
      `insert into org_contacts (org_id, contact_owner_user_id, visitor_name, letter_status, onboarding_status)
       values ($1, $2, 'Visiting Prospect Org', 'sent', 'pending')`,
      [org.id, secondaryMember]
    );

    // EOD (PRD §8.9) — one filed-today entry so the EOD view and
    // getMembersExpectedToday-equivalent checks have a real row.
    await client.query(
      `insert into eod_logs (org_id, user_id, filed_by_user_id, date, summary)
       values ($1, $2, $2, current_date, $3)
       on conflict (org_id, user_id, date) do nothing`,
      [org.id, primaryMember, 'Closed out three follow-ups, no blockers to report.']
    );

    // Task Trends (PRD §8.7, 0033-adjacent) — 14 synthetic-but-plausible
    // days so Analytics' TaskTrendsChart renders on a fresh DB instead
    // of the empty state. Same shape as seedClickthrough.ts's own
    // generator, kept here rather than shared since this is the only
    // other caller and a shared util isn't worth it for one duplicate.
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const openTasks = 12 + Math.round(Math.sin(i / 2) * 3) + (13 - i);
      const doneToday = isWeekend ? Math.round(Math.random() * 1) : 1 + Math.round(Math.random() * 3);
      const overdue = Math.max(0, Math.round(1 + Math.sin(i / 3) * 2));
      const atRisk = Math.max(0, Math.round(2 + Math.cos(i / 2.5) * 2));
      await client.query(
        `insert into task_trends (org_id, date, user_id, open_tasks, done_today, overdue, at_risk)
         values ($1, $2, null, $3, $4, $5, $6)`,
        [org.id, dateStr, openTasks, doneToday, overdue, atRisk]
      );
    }
  });
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log('Seeding NEXUS dev environment (fresh DB assumed)...\n');

  // --- Org tree: one Group, two Companies under it -----------------
  const group = await createOrg('ABION Industries', 'group', null);
  const foods = await createOrg('ABION Foods Ltd', 'company', group.id);
  const logistics = await createOrg('ABION Logistics Ltd', 'company', group.id);

  // --- Platform Admin, doubling as the Group's own Leader/"Group
  // Admin" (per authorizationService.isGroupAdmin: leader role on a
  // group-type org, no separate concept) ----------------------------
  const ayo = await withOrgContext(group.id, (client) =>
    makeUser(client, group.id, {
      name: 'Ayo Joshua',
      email: 'ayo@abion.dev',
      role: 'leader',
      title: 'Founder / CEO',
    })
  );
  await pool.query(`insert into platform_admins (user_id) values ($1)`, [ayo.id]);

  // --- Company Admins/Leaders (leader role on a company-type org —
  // same "no separate concept" shape as Group Admin above) ----------
  const femi = await withOrgContext(foods.id, (client) =>
    makeUser(client, foods.id, { name: 'Femi Adebayo', email: 'femi@abion.dev', role: 'leader', title: 'MD, ABION Foods' })
  );
  const ronke = await withOrgContext(logistics.id, (client) =>
    makeUser(client, logistics.id, {
      name: 'Ronke Balogun',
      email: 'ronke@abion.dev',
      role: 'leader',
      title: 'MD, ABION Logistics',
    })
  );
  // Second named leader on Logistics — PRD §3's roster (Ayo, Femi,
  // Ronke, Bassey) had four leaders total, not one-per-company.
  const bassey = await withOrgContext(logistics.id, (client) =>
    makeUser(client, logistics.id, {
      name: 'Bassey Etuk',
      email: 'bassey@abion.dev',
      role: 'leader',
      title: 'COO, ABION Logistics',
    })
  );

  // --- Team Members + one Intern -------------------------------------
  const foodsTeam = await withOrgContext(foods.id, async (client) => [
    await makeUser(client, foods.id, { name: 'Chidi Okoro', email: 'chidi@abion.dev', role: 'team_member', title: 'Ops Lead' }),
    await makeUser(client, foods.id, {
      name: 'Amara Nwosu',
      email: 'amara@abion.dev',
      role: 'team_member',
      title: 'Marketing',
    }),
    await makeUser(client, foods.id, { name: 'Tolu Bankole', email: 'tolu@abion.dev', role: 'intern', title: 'Intern' }),
  ]);
  const logisticsTeam = await withOrgContext(logistics.id, async (client) => [
    await makeUser(client, logistics.id, {
      name: 'Emeka Nnaji',
      email: 'emeka@abion.dev',
      role: 'team_member',
      title: 'Fleet Coordinator',
    }),
    await makeUser(client, logistics.id, {
      name: 'Hauwa Bello',
      email: 'hauwa@abion.dev',
      role: 'team_member',
      title: 'Partnerships',
    }),
  ]);

  // --- Resource+action permission grants (PRD §13.3 example grants —
  // "Team Member → network.cos → read (if Trusted_COS = true)") ------
  await grantPermission(foods.id, femi.id, foodsTeam[1]!.id, 'network.partnerships', 'update'); // Amara
  await grantPermission(logistics.id, ronke.id, logisticsTeam[1]!.id, 'network.cos', 'read'); // Hauwa

  // --- Operational data per company ----------------------------------
  await seedOperationalData({ org: foods, leaderId: femi.id, members: foodsTeam });
  await seedOperationalData({ org: logistics, leaderId: ronke.id, members: logisticsTeam });

  // --- Convenience sessions for curl testing without going through
  // the dev-login roster UI first. Not the primary roster mechanism —
  // devAuth.ts's GET /roster (backed by list_users_for_dev_login,
  // 0010) already lists every user seeded above for free, with no
  // extra step needed here. ------------------------------------------
  const ayoSession = await createSession(ayo.id, group.id);
  const femiSession = await createSession(femi.id, foods.id);

  console.log(
    JSON.stringify(
      {
        organizations: { group: group.id, foods: foods.id, logistics: logistics.id },
        platformAdmin: { userId: ayo.id, email: ayo.email, token: ayoSession.token },
        sampleCompanyLeaderSession: { userId: femi.id, email: femi.email, token: femiSession.token },
        seededUsers: [ayo, femi, ronke, bassey, ...foodsTeam, ...logisticsTeam].map((u) => ({
          name: u.name,
          email: u.email,
          role: u.role,
        })),
        devLoginRoster: 'GET /dev-auth/roster (DEV_LOGIN=true) lists all of the above automatically.',
      },
      null,
      2
    )
  );
}

main()
  .then(() => {
    console.log('\nSeed complete.');
    return pool.end();
  })
  .catch((err) => {
    console.error('Seed failed:', err);
    return pool.end().finally(() => process.exit(1));
  });
