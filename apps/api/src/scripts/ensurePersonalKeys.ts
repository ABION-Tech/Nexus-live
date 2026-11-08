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
      const [email = '', name = '', prefix = '', sha = ''] = g.split('|').map((x) => x.trim());
      return { email: email.toLowerCase(), name, prefix, sha: sha.toLowerCase() };
    })
    .filter((g) => {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email) && g.name.length > 0 && g.name.length <= 60 && /^nxk_/.test(g.prefix) && /^[0-9a-f]{64}$/.test(g.sha);
      if (!ok) console.warn(`ensurePersonalKeys: skipped a malformed grant for "${g.email}".`);
      return ok;
    });
  if (grants.length === 0) {
    console.log('ensurePersonalKeys: PERSONAL_KEY_GRANTS not set, skipping.');
    return;
  }

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
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.warn('ensurePersonalKeys: failed, continuing deploy.', err instanceof Error ? err.message : err);
});
