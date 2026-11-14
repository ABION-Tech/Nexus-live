// Pre-deploy step (after ensurePlatformAdmins). Registers personal API keys
// that were generated somewhere else, from their SHA-256 fingerprint only.
//
// Used once in Session 56 to connect Synergia: Synergia's database
// generated the key and kept it; Nexus was only ever given
//   PERSONAL_KEY_GRANTS="email|name|prefix|sha256hex[;…]"
// so the key itself never passed through an env var, a log or a chat.
// Additive and idempotent: an existing fingerprint is left alone, and a
// key revoked in Settings → Account stays revoked (its row still exists).
// Never fails the deploy: problems are logged as warnings.
import 'dotenv/config';
import pg from 'pg';

async function main() {
  const grants = (process.env.PERSONAL_KEY_GRANTS ?? '')
    .split(';')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => {
      const [email = '', name = '', prefix = '', sha = '', scopes = ''] = g.split('|').map((x) => x.trim());
      // Session 59: optional 5th field, extra scopes ("tasks:import").
      const extra = scopes.split(',').map((x) => x.trim()).filter((x) => x === 'tasks:read' || x === 'tasks:import');
      return { email: email.toLowerCase(), name, prefix, sha: sha.toLowerCase(), extra };
    })
    .filter((g) => {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email) && g.name.length > 0 && g.name.length <= 60 && /^nxk_/.test(g.prefix) && /^[0-9a-f]{64}$/.test(g.sha);
      if (!ok) console.warn(`ensurePersonalKeys: skipped a malformed grant for "${g.email}".`);
      return ok;
    });
  if (grants.length === 0) console.log('ensurePersonalKeys: PERSONAL_KEY_GRANTS not set, skipping.');

  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const g of grants) {
      const { rows: users } = await client.query<{ id: string; home_org_id: string | null }>(
        `select id, home_org_id from users where lower(email) = $1`,
        [g.email]
      );
      const user = users[0];
      if (!user?.home_org_id) {
        console.warn(`ensurePersonalKeys: ${g.email} has no account or home organization yet; skipped.`);
        continue;
      }
      const res = await client.query(
        `insert into personal_api_keys (user_id, org_id, name, prefix, key_hash)
         values ($1, $2, $3, $4, $5)
         on conflict (key_hash) do nothing`,
        [user.id, user.home_org_id, g.name, g.prefix, g.sha]
      );
      console.log(`ensurePersonalKeys: "${g.name}" key for ${g.email} ${res.rowCount ? 'registered' : 'already present'}.`);
      if (g.extra.length) {
        await client.query(
          `update personal_api_keys set scopes = array(select distinct unnest(scopes || $2::text[])) where key_hash = $1 and revoked_at is null`,
          [g.sha, g.extra]
        );
        console.log(`ensurePersonalKeys: "${g.name}" key can now ${g.extra.join(', ')}.`);
      }
    }
    await ensureMemberCompanies(client);
  } finally {
    await client.end();
  }
}

// Session 59 — MEMBER_COMPANIES="email|Company name|role[;…]": make sure
// a company of that name exists (created as an independent company if
// not) and that this person is a member with that role. Additive: never
// renames, moves or removes anything; an existing membership is left as is.
async function ensureMemberCompanies(client: pg.Client) {
  const specs = (process.env.MEMBER_COMPANIES ?? '')
    .split(';')
    .map((x) => x.split('|').map((y) => y.trim()))
    .filter(([email, name]) => email && name);
  for (const [emailRaw = '', name = '', roleRaw = 'leader'] of specs) {
    const email = emailRaw.toLowerCase();
    const role = ['leader', 'team_member', 'intern'].includes(roleRaw) ? roleRaw : 'leader';
    const { rows: users } = await client.query<{ id: string }>(`select id from users where lower(email) = $1`, [email]);
    if (!users[0]) {
      console.warn(`ensurePersonalKeys: no account for ${email}; company "${name}" skipped.`);
      continue;
    }
    let { rows: orgs } = await client.query<{ id: string }>(`select id from organizations where lower(name) = lower($1) and org_type = 'company' order by created_at limit 1`, [name]);
    if (!orgs[0]) {
      ({ rows: orgs } = await client.query<{ id: string }>(`insert into organizations (name, org_type) values ($1, 'company') returning id`, [name]));
      console.log(`ensurePersonalKeys: company "${name}" created.`);
    }
    const m = await client.query(
      `insert into org_memberships (user_id, org_id, role, is_home) values ($1, $2, $3, false) on conflict (user_id, org_id) do nothing`,
      [users[0].id, orgs[0]!.id, role]
    );
    console.log(`ensurePersonalKeys: ${email} ${m.rowCount ? 'added to' : 'already in'} "${name}".`);
  }
}

main().catch((err) => {
  console.warn('ensurePersonalKeys: failed, continuing deploy.', err instanceof Error ? err.message : err);
});
