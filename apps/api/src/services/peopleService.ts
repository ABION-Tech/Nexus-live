// PRD §8.4 People/team-members — read-only org roster. Backs routes/
// people.ts, which exists purely to unblock the Network frontend's
// assignee/owner pickers (Partnerships.tsx / OrgDatabase.tsx). Not a full
// CRUD module: adding/removing team members happens via the invite flow
// (routes/invites.ts) — this file only ever selects from `users`, never
// writes to it.
import { withOrgContext } from '../db.js';
import type { Person } from '@nexus/shared';

interface PersonRow {
  id: string;
  name: string;
  email: string;
  role: Person['role'];
  avatar_url: string | null;
}

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarUrl: row.avatar_url ?? undefined,
  };
}

/** Whole-org roster, alphabetical by name — this is a picker source, not a
 * paginated list; every org member is a valid assignee/owner candidate,
 * so there's no filtering by role or status here.
 *
 * Fixed in Session 19: this previously selected `role` and filtered on
 * `org_id` directly against `users`, which predates
 * 0006_org_hierarchy_memberships.sql — `users` has no `org_id` column
 * (only `home_org_id`, a person's default workspace) and no `role`
 * column (role is per-org, on `org_memberships`, since a person's role
 * can differ across orgs they belong to). This route/service pair had
 * never been exercised against a real Postgres before — Session 18's
 * network.test.ts mocks this whole service out, so the bug shipped
 * unnoticed. Caught by the click-through verification in Session 19
 * (`seedClickthrough.ts` + curl against a live local Postgres), not by
 * inspection or the existing test suite. */
export async function listOrgPeople(orgId: string): Promise<Person[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PersonRow>(
      `select u.id, u.name, u.email, m.role, u.avatar_url
         from users u
         join org_memberships m on m.user_id = u.id and m.org_id = $1
        order by u.name asc`,
      [orgId]
    );
    return rows.map(toPerson);
  });
}
