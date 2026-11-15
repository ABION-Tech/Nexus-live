// Session 60 (C-09) — deploy step: encrypt any AI provider key still
// stored in plain text (saved before encryption existed). Idempotent:
// already-encrypted values are left alone. Does nothing, and says so,
// when SECRET_ENCRYPTION_KEY isn't set. Runs as the migration owner (no
// company context: it covers every company), like the other ensure*
// scripts.
import pg from 'pg';
import { encryptSecret, isEncrypted } from '../services/secretBox.js';

async function main() {
  if (!process.env.SECRET_ENCRYPTION_KEY) {
    console.log('ensureEncryptedSecrets: SECRET_ENCRYPTION_KEY not set, skipping.');
    return;
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ org_id: string; api_key: string }>(
      `select org_id, api_key from ai_settings where api_key is not null and api_key not like 'enc:v1:%'`
    );
    for (const r of rows) {
      if (isEncrypted(r.api_key)) continue;
      await client.query(`update ai_settings set api_key = $2 where org_id = $1 and api_key = $3`, [r.org_id, encryptSecret(r.api_key), r.api_key]);
    }
    console.log(`ensureEncryptedSecrets: encrypted ${rows.length} AI provider key(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ensureEncryptedSecrets failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
