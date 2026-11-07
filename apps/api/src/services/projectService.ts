// Project lifecycle data access. ADMIN_BUILD_GUIDE.md §2: "same shape
// already used twice — GoalWithProgress; marketing_content's entry +
// chained stage tasks — applied a third time." This file mirrors
// goalService.ts's actual structure (not just its shape) deliberately,
// so a future reader who already knows one knows both.
//
// Two read paths, not one:
//   - getProjectWithTasks(orgId, projectId) — the normal same-org path,
//     gated by the caller's own 'projects' permission (routes/projects.ts).
//   - getProjectForMember(userId, projectId) — the project_memberships
//     path: authorizes against that table on the raw pool first (same
//     "check outside RLS, then read inside a correctly-scoped
//     withOrgContext" shape authorizationService.withAuthorizedOrgContext
//     already uses for the group/company case), then reads the rest of
//     the project's data using the PROJECT's own org_id — not the
//     caller's session org. This is what lets a same-org guest or a
//     genuinely cross-org collaborator (DECISIONS.md §5's Company-B-on-
//     Company-A's-project sketch) see one project's full contents
//     without any RLS policy on `projects`/`tasks` being widened.
import { pool, withOrgContext } from '../db.js';
import { diffColumns, logActivity, logActivityCreated } from './activityLogService.js';
import { toTask, type TaskRow } from './taskService.js';
import type { Project, ProjectMember, ProjectStatus, ProjectWithTasks, Task } from '@nexus/shared';
import type { PoolClient } from 'pg';

interface ProjectRow {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  created_by_user_id: string;
  created_at: Date;
}

interface ProjectMemberRow {
  user_id: string;
  name: string;
  email: string;
  org_id: string; // the member's own home org (joined from users.home_org_id), not projects.org_id
  added_by_user_id: string | null;
  created_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

function toProjectMember(row: ProjectMemberRow): ProjectMember {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    orgId: row.org_id,
    addedByUserId: row.added_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

const MEMBER_SELECT = `
  select pm.user_id, u.name, u.email, u.home_org_id as org_id, pm.added_by_user_id, pm.created_at
    from project_memberships pm
    join users u on u.id = pm.user_id
   where pm.project_id = $1
   order by pm.created_at asc
`;

// Deliberately run on the raw `pool`, not the `client` inside
// withOrgContext(project's org, ...) — `users`' own RLS policy
// (0006_org_hierarchy_memberships.sql) only shows a user row when they
// hold an org_memberships row in the *current* org. A guest does (Session
// 37's createGuestCredential gives them one in the company that created
// them), but a genuine cross-org collaborator per DECISIONS.md §5's
// sketch — added to a project via project_memberships alone, with no
// org_memberships row in the project's owning org — would silently
// resolve to zero rows under that policy, which would make the member
// list quietly drop them rather than show them. This bypass is scoped
// to exactly the user ids project_memberships already told us are
// legitimate members of this one project (same class of "checked
// outside RLS on purpose" as authorizationService.canReadOrg's own
// organizations lookups), not a general users query.
async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
  const { rows } = await pool.query<ProjectMemberRow>(MEMBER_SELECT, [projectId]);
  return rows.map(toProjectMember);
}

async function fetchMembersForProjects(projectIds: string[]): Promise<Map<string, ProjectMember[]>> {
  const { rows } = await pool.query<ProjectMemberRow & { project_id: string }>(
    `select pm.project_id, pm.user_id, u.name, u.email, u.home_org_id as org_id, pm.added_by_user_id, pm.created_at
       from project_memberships pm
       join users u on u.id = pm.user_id
      where pm.project_id = any($1::uuid[])
      order by pm.created_at asc`,
    [projectIds]
  );
  const byProject = new Map<string, ProjectMember[]>();
  for (const row of rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(toProjectMember(row));
    byProject.set(row.project_id, list);
  }
  return byProject;
}

async function loadTasksAndMembers(
  client: PoolClient,
  orgId: string,
  projectId: string
): Promise<{ tasks: Task[]; members: ProjectMember[] }> {
  const [tasksResult, members] = await Promise.all([
    client.query<TaskRow>(
      `select * from tasks where org_id = $1 and project_id = $2 and archived_at is null order by created_at asc`,
      [orgId, projectId]
    ),
    fetchMembers(projectId),
  ]);
  return { tasks: tasksResult.rows.map(toTask), members };
}

function withCounts(project: Project, tasks: Task[], members: ProjectMember[]): ProjectWithTasks {
  return {
    ...project,
    tasks,
    members,
    taskCount: tasks.length,
    doneTaskCount: tasks.filter((t) => t.status === 'done').length,
  };
}

export interface CreateProjectInput {
  title: string;
  description?: string;
  createdByUserId: string;
}

export async function createProject(orgId: string, input: CreateProjectInput): Promise<Project> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `insert into projects (org_id, title, description, created_by_user_id) values ($1, $2, $3, $4) returning *`,
      [orgId, input.title, input.description ?? null, input.createdByUserId]
    );
    const project = toProject(rows[0]!);
    await logActivityCreated(client, { orgId, actorUserId: input.createdByUserId, resourceType: 'projects', resourceId: project.id });
    return project;
  });
}

export async function listProjects(orgId: string, status?: ProjectStatus): Promise<Project[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = status
      ? await client.query<ProjectRow>(`select * from projects where org_id = $1 and status = $2 order by created_at desc`, [
          orgId,
          status,
        ])
      : await client.query<ProjectRow>(`select * from projects where org_id = $1 order by created_at desc`, [orgId]);
    return rows.map(toProject);
  });
}

/** ADMIN_BUILD_GUIDE.md §2: "List view with inline expand (trimmed task
 * summary)" — the list itself carries each project's tasks so the row
 * can expand client-side with no second fetch, same reasoning
 * GoalWithProgress gives for bundling progress into one payload (though
 * ActiveGoals.tsx made the opposite call for its own list, to avoid an
 * N+1 — the difference here is the guide asking for the summary to
 * render inline in the list itself, not just on drill-in, so this really
 * does need the join up front. Two queries total, not N+1: one for
 * projects, one for every task across all of them, grouped in memory.) */
export async function listProjectsWithTasks(orgId: string, status?: ProjectStatus): Promise<ProjectWithTasks[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows: projectRows } = status
      ? await client.query<ProjectRow>(`select * from projects where org_id = $1 and status = $2 order by created_at desc`, [
          orgId,
          status,
        ])
      : await client.query<ProjectRow>(`select * from projects where org_id = $1 order by created_at desc`, [orgId]);

    if (projectRows.length === 0) return [];
    const projectIds = projectRows.map((r) => r.id);

    const [tasksResult, membersByProject] = await Promise.all([
      client.query<TaskRow>(
        `select * from tasks where org_id = $1 and project_id = any($2::uuid[]) and archived_at is null order by created_at asc`,
        [orgId, projectIds]
      ),
      fetchMembersForProjects(projectIds),
    ]);

    const tasksByProject = new Map<string, Task[]>();
    for (const row of tasksResult.rows) {
      const t = toTask(row);
      const list = tasksByProject.get(t.projectId!) ?? [];
      list.push(t);
      tasksByProject.set(t.projectId!, list);
    }

    return projectRows.map((row) =>
      withCounts(toProject(row), tasksByProject.get(row.id) ?? [], membersByProject.get(row.id) ?? [])
    );
  });
}

/** Same-org path — caller already has 'projects' permission in this org
 * (checked by the route, not here, same division of responsibility
 * goalService.ts's own top-of-file comment describes). */
export async function getProjectWithTasks(orgId: string, projectId: string): Promise<ProjectWithTasks | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<ProjectRow>(`select * from projects where org_id = $1 and id = $2`, [orgId, projectId]);
    if (rows.length === 0) return null;
    const project = toProject(rows[0]!);
    const { tasks, members } = await loadTasksAndMembers(client, orgId, projectId);
    return withCounts(project, tasks, members);
  });
}

/** The project_memberships path — see this file's top-of-file comment.
 * Returns null uniformly for "no such project" and "not a member of it",
 * same don't-leak-which-case-it-was posture the rest of this codebase's
 * auth-adjacent lookups already take (verifyGuestLogin, verifySession). */
export async function getProjectForMember(userId: string, projectId: string): Promise<ProjectWithTasks | null> {
  const { rows: membershipRows } = await pool.query(
    `select 1 from project_memberships where project_id = $1 and user_id = $2`,
    [projectId, userId]
  );
  if (membershipRows.length === 0) return null;

  const { rows: projectRows } = await pool.query<ProjectRow>(`select * from projects where id = $1`, [projectId]);
  const projectRow = projectRows[0];
  if (!projectRow) return null;

  return withOrgContext(projectRow.org_id, async (client) => {
    const project = toProject(projectRow);
    const { tasks, members } = await loadTasksAndMembers(client, projectRow.org_id, projectId);
    return withCounts(project, tasks, members);
  });
}

/** Projects a given user has project-scoped access to via
 * project_memberships — the guest/collaborator equivalent of listProjects,
 * used by routes/projects.ts's list route when the caller lacks a
 * blanket 'projects' read grant. Runs one withOrgContext per distinct
 * owning org among the member's projects (almost always one, for a
 * same-org guest; more than one only for a genuine multi-org
 * collaborator) — same N-separately-scoped-queries shape as every other
 * cross-org merge in this codebase, not a widened single query. */
export async function listProjectsForMember(userId: string): Promise<ProjectWithTasks[]> {
  const { rows: membershipRows } = await pool.query<{ project_id: string; org_id: string }>(
    `select project_id, org_id from project_memberships where user_id = $1`,
    [userId]
  );
  if (membershipRows.length === 0) return [];

  const projectIdsByOrg = new Map<string, string[]>();
  for (const row of membershipRows) {
    const list = projectIdsByOrg.get(row.org_id) ?? [];
    list.push(row.project_id);
    projectIdsByOrg.set(row.org_id, list);
  }

  const results: ProjectWithTasks[] = [];
  for (const [orgId, projectIds] of projectIdsByOrg) {
    const orgResults = await withOrgContext(orgId, async (client) => {
      const { rows: projectRows } = await client.query<ProjectRow>(
        `select * from projects where org_id = $1 and id = any($2::uuid[]) order by created_at desc`,
        [orgId, projectIds]
      );
      const out: ProjectWithTasks[] = [];
      for (const row of projectRows) {
        const { tasks, members } = await loadTasksAndMembers(client, orgId, row.id);
        out.push(withCounts(toProject(row), tasks, members));
      }
      return out;
    });
    results.push(...orgResults);
  }
  return results;
}

export class ProjectMembershipError extends Error {
  constructor(
    public code: 'not_found' | 'already_member',
    message: string
  ) {
    super(message);
    this.name = 'ProjectMembershipError';
  }
}

/** Adds a member by user id — cross-org on purpose, the FK is to `users`
 * generally, not scoped to the project's own org (see 0017_projects.sql).
 * The caller (route) is responsible for having already resolved which
 * user id corresponds to whichever email/name was entered; this function
 * just records the grant. */
export async function addProjectMember(orgId: string, projectId: string, userId: string, addedByUserId: string): Promise<ProjectMember> {
  return withOrgContext(orgId, async (client) => {
    const { rows: projectRows } = await client.query(`select 1 from projects where org_id = $1 and id = $2`, [orgId, projectId]);
    if (projectRows.length === 0) throw new ProjectMembershipError('not_found', 'Project not found.');

    try {
      await client.query(
        `insert into project_memberships (project_id, org_id, user_id, added_by_user_id) values ($1, $2, $3, $4)`,
        [projectId, orgId, userId, addedByUserId]
      );
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        throw new ProjectMembershipError('already_member', 'This user is already a member of the project.');
      }
      throw err;
    }

    const { rows } = await pool.query<ProjectMemberRow>(
      `select u.id as user_id, u.name, u.email, u.home_org_id as org_id, $1::uuid as added_by_user_id, now() as created_at
         from users u where u.id = $2`,
      [addedByUserId, userId]
    );
    return toProjectMember(rows[0]!);
  });
}

export async function removeProjectMember(orgId: string, projectId: string, userId: string): Promise<boolean> {
  return withOrgContext(orgId, async (client) => {
    const { rowCount } = await client.query(
      `delete from project_memberships where project_id = $1 and org_id = $2 and user_id = $3`,
      [projectId, orgId, userId]
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function archiveProject(orgId: string, projectId: string, actorUserId: string | null = null): Promise<Project | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<ProjectRow>(`select * from projects where org_id = $1 and id = $2`, [orgId, projectId]);
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<ProjectRow>(
      `update projects set status = 'archived' where org_id = $1 and id = $2 and status = 'active' returning *`,
      [orgId, projectId]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, ['status']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'projects', resourceId: projectId, changes });
    }
    return toProject(after);
  });
}

/** Inverse of archiveProject — same reasoning as goalService.restoreGoal:
 * archive-only with no way back is a dead end. */
export async function restoreProject(orgId: string, projectId: string, actorUserId: string | null = null): Promise<Project | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<ProjectRow>(`select * from projects where org_id = $1 and id = $2`, [orgId, projectId]);
    const before = beforeRows[0];
    if (!before) return null;

    const { rows } = await client.query<ProjectRow>(
      `update projects set status = 'active' where org_id = $1 and id = $2 and status = 'archived' returning *`,
      [orgId, projectId]
    );
    const after = rows[0];
    if (!after) return null;

    const changes = diffColumns(before, after, ['status']);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'projects', resourceId: projectId, changes });
    }
    return toProject(after);
  });
}
