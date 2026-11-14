// Session 57 — one person, many companies.
//
// Your account is yours; companies invite you in. Each company only ever
// sees its own work (every company query still runs inside
// withOrgContext, so RLS keeps companies apart exactly as before). The
// only things that cross company lines are about *you*: the list of your
// companies, your own invitations, and your own tasks across all of them.
// Those go through 0040's SECURITY DEFINER functions, always keyed by the
// user id from a verified session, and return nothing about anyone else.
import type { CrossCompanyTask, Role, Workspace, WorkspaceInvitation } from '@nexus/shared';
import { pool, withOrgContext } from '../db.js';
import { listTasks } from './taskService.js';
import { recomputeSeatCount } from './billingService.js';

export class WorkspaceError extends Error {
  constructor(
    public code: 'not_member' | 'not_found' | 'inactive',
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

interface WorkspaceRow {
  org_id: string;
  name: string;
  org_type: 'group' | 'company';
  parent_name: string | null;
  role: string;
  is_home: boolean;
  active: boolean;
}

async function workspaceRows(userId: string): Promise<WorkspaceRow[]> {
  const { rows } = await pool.query<WorkspaceRow>(
    `select org_id, name, org_type, parent_name, role, is_home, active from my_workspaces($1)`,
    [userId]
  );
  return rows;
}

/** Every company you belong to. Deactivated companies are left out
 * (you can't work in them), unless it's the one you're in right now. */
export async function listWorkspaces(userId: string, currentOrgId: string): Promise<Workspace[]> {
  const rows = await workspaceRows(userId);
  return rows
    .filter((r) => r.active || r.org_id === currentOrgId)
    .map((r) => ({
      orgId: r.org_id,
      name: r.name,
      orgType: r.org_type,
      parentName: r.parent_name ?? undefined,
      role: r.role,
      isHome: r.is_home,
      isCurrent: r.org_id === currentOrgId,
    }));
}

export async function listInvitations(userId: string): Promise<WorkspaceInvitation[]> {
  const { rows } = await pool.query<{
    id: string;
    org_id: string;
    org_name: string;
    role: string;
    invited_by_name: string | null;
    created_at: Date;
    expires_at: Date;
  }>(`select id, org_id, org_name, role, invited_by_name, created_at, expires_at from my_pending_invites($1)`, [userId]);
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    role: r.role,
    invitedByName: r.invited_by_name ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
  }));
}

async function requireMembership(userId: string, orgId: string): Promise<WorkspaceRow> {
  const row = (await workspaceRows(userId)).find((r) => r.org_id === orgId);
  if (!row) throw new WorkspaceError('not_member', "You aren't a member of that company.");
  if (!row.active) throw new WorkspaceError('inactive', 'That company has been deactivated.');
  return row;
}

/** Moves this session into another of your companies. The session row
 * is RLS-exempt (DECISIONS.md #4), so the membership check here is the
 * guard 0006 asked for: a session can never point at a company you
 * aren't in. The role is re-read from that company's membership on the
 * very next request (sessionService.verifySession). */
export async function switchWorkspace(params: { sessionId: string; userId: string; orgId: string }): Promise<Workspace> {
  const row = await requireMembership(params.userId, params.orgId);
  const { rowCount } = await pool.query(
    `update sessions set org_id = $1 where id = $2 and user_id = $3 and revoked_at is null`,
    [params.orgId, params.sessionId, params.userId]
  );
  if (!rowCount) throw new WorkspaceError('not_found', 'Your session has ended. Sign in again.');
  return {
    orgId: row.org_id,
    name: row.name,
    orgType: row.org_type,
    parentName: row.parent_name ?? undefined,
    role: row.role,
    isHome: row.is_home,
    isCurrent: true,
  };
}

/** The company you land in when you sign in. */
export async function setHomeWorkspace(userId: string, orgId: string): Promise<void> {
  await requireMembership(userId, orgId);
  await pool.query(`select set_home_workspace($1, $2)`, [userId, orgId]);
}

async function pendingInvitation(userId: string, inviteId: string): Promise<WorkspaceInvitation> {
  const invite = (await listInvitations(userId)).find((i) => i.id === inviteId);
  if (!invite) throw new WorkspaceError('not_found', 'That invitation is no longer open.');
  return invite;
}

/** Join: adds a membership in the inviting company. Nothing else about
 * you changes — your other companies, your home company and your sign-in
 * stay exactly as they were. */
export async function acceptInvitation(userId: string, inviteId: string): Promise<Workspace> {
  const invite = await pendingInvitation(userId, inviteId);

  await withOrgContext(invite.orgId, async (client) => {
    // Claim first, guarded on still-open, so a double tap can't add two
    // memberships or accept an invite revoked a moment ago.
    const claim = await client.query<{ invited_by: string; grant_platform_admin: boolean }>(
      `update invites set accepted_at = now(), accepted_user_id = $2
        where id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
        returning invited_by, grant_platform_admin`,
      [inviteId, userId]
    );
    if (!claim.rowCount) throw new WorkspaceError('not_found', 'That invitation is no longer open.');

    await client.query(
      `insert into org_memberships (user_id, org_id, role, is_home, granted_by)
       values ($1, $2, $3, false, $4)
       on conflict (user_id, org_id) do nothing`,
      [userId, invite.orgId, invite.role as Role, claim.rows[0]!.invited_by]
    );

    if (claim.rows[0]!.grant_platform_admin) {
      await client.query(
        `insert into platform_admins (user_id, granted_by) values ($1, $2) on conflict (user_id) do nothing`,
        [userId, claim.rows[0]!.invited_by]
      );
    }
  });

  // Best-effort, as at first sign-in (routes/auth.ts).
  await recomputeSeatCount(invite.orgId).catch(() => undefined);

  return {
    orgId: invite.orgId,
    name: invite.orgName,
    orgType: 'company',
    role: invite.role,
    isHome: false,
    isCurrent: false,
  };
}

/** Decline: the company sees the invite as no longer pending, and can
 * invite you again later if you change your mind. */
export async function declineInvitation(userId: string, inviteId: string): Promise<void> {
  const invite = await pendingInvitation(userId, inviteId);
  await withOrgContext(invite.orgId, async (client) => {
    await client.query(
      `update invites set declined_at = now(), revoked_at = now()
        where id = $1 and accepted_at is null and revoked_at is null`,
      [inviteId]
    );
  });
}

const PAGE = 100;
const MAX_PAGES = 5;

/** Your tasks in every company you belong to, newest first, each tagged
 * with its company. Each company is read in its own withOrgContext, so
 * this is literally "the same My Tasks query, once per company" — it can
 * never return a task you couldn't already see by switching to that
 * company. `orgId` narrows it to one company. */
export async function listMyWorkAcrossCompanies(
  userId: string,
  opts: { orgId?: string; includeDone?: boolean } = {}
): Promise<{ companies: { id: string; name: string; open: number }[]; tasks: CrossCompanyTask[] }> {
  const rows = (await workspaceRows(userId)).filter((r) => r.active);
  const companies: { id: string; name: string; open: number }[] = [];
  const tasks: CrossCompanyTask[] = [];

  for (const ws of rows) {
    const mine = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await listTasks(ws.org_id, { involvingUserId: userId, page, pageSize: PAGE });
      mine.push(...res.tasks);
      if (mine.length >= res.total || res.tasks.length === 0) break;
    }
    companies.push({ id: ws.org_id, name: ws.name, open: mine.filter((t) => t.status !== 'done').length });
    if (opts.orgId && opts.orgId !== ws.org_id) continue;

    for (const t of mine) {
      if (!opts.includeDone && t.status === 'done') continue;
      tasks.push({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        role: t.assignedToUserId === userId ? 'owner' : t.supportUserId === userId ? 'support' : 'supervisor',
        startDate: t.startDate,
        deadline: t.deadline,
        department: t.department,
        business: t.business,
        updatedAt: t.updatedAt,
        company: { id: ws.org_id, name: ws.name },
      });
    }
  }

  tasks.sort((a, b) => {
    // Soonest deadline first; undated last; then most recently touched.
    const da = a.deadline ?? '9999';
    const db = b.deadline ?? '9999';
    return da === db ? b.updatedAt.localeCompare(a.updatedAt) : da.localeCompare(db);
  });
  return { companies, tasks };
}
