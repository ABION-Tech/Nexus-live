// Pre-deploy step (after migrate.js). Makes sure every address in
// PLATFORM_ADMIN_EMAILS (comma-separated) is a NEXUS Super Admin:
//   - has an account  -> platform_admins row (idempotent)
//   - no account yet  -> a pending leader invite into the home org with
//                        grant_platform_admin = true (0037), so the grant
//                        applies the moment they first sign in with Google.
// Home org: PLATFORM_ADMIN_HOME_ORG_ID, else the earliest existing Super
// Admin's home org. Additive only: never removes anyone (removal is a
// deliberate action in Platform > Super Admins, with its own guards).
// Runs as the migration (owner) role, like migrate.js. Never fails the
// deploy: problems are logged as warnings.
import 'dotenv/config';
import pg from 'pg';

async function main() {
  const emails = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (emails.length === 0) {
    console.log('ensurePlatformAdmins: PLATFORM_ADMIN_EMAILS not set, skipping.');
    return;
  }

  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: firstAdmin } = await client.query<{ user_id: string; home_org_id: string | null }>(
      `select pa.user_id, u.home_org_id
         from platform_admins pa join users u on u.id = pa.user_id
        order by pa.granted_at asc limit 1`
    );
    const inviterId = firstAdmin[0]?.user_id ?? null;
    const homeOrgId = process.env.PLATFORM_ADMIN_HOME_ORG_ID || firstAdmin[0]?.home_org_id || null;

    for (const email of emails) {
      const { rows: users } = await client.query<{ id: string }>(
        `select id from users where lower(email) = $1`,
        [email]
      );
      if (users.length > 0) {
        const res = await client.query(
          `insert into platform_admins (user_id, granted_by) values ($1, $2) on conflict (user_id) do nothing`,
          [users[0]!.id, inviterId]
        );
        console.log(`ensurePlatformAdmins: ${email} ${res.rowCount ? 'granted Super Admin' : 'already a Super Admin'}.`);
        continue;
      }

      if (!inviterId || !homeOrgId) {
        console.warn(
          `ensurePlatformAdmins: ${email} has no account and there is no existing Super Admin/home org to invite them from; skipped.`
        );
        continue;
      }

      const { rows: live } = await client.query<{ id: string }>(
        `select id from invites
          where org_id = $1 and lower(email) = $2
            and accepted_at is null and revoked_at is null and expires_at > now()`,
        [homeOrgId, email]
      );
      if (live.length > 0) {
        await client.query(`update invites set grant_platform_admin = true where id = $1`, [live[0]!.id]);
        console.log(`ensurePlatformAdmins: ${email} already invited; marked as a Super Admin invite.`);
      } else {
        await client.query(
          `insert into invites (org_id, email, role, invited_by, grant_platform_admin, expires_at)
           values ($1, $2, 'leader', $3, true, now() + interval '30 days')`,
          [homeOrgId, email, inviterId]
        );
        console.log(`ensurePlatformAdmins: ${email} invited as Super Admin (applies on first Google sign-in).`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.warn('ensurePlatformAdmins: unexpected error:', err);
});
