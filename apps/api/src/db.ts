// Postgres access. Two entry points, deliberately different:
//
// - `pool` — the raw pool. Only ever used for the sessions table (see
//   DECISIONS.md #4) and other pre-org-context bootstrapping. Using this
//   for anything else silently bypasses RLS-backed tenant isolation.
// - `withOrgContext(orgId, fn)` — every other query goes through this.
//   Opens a transaction, issues `SET LOCAL app.current_org_id`, runs `fn`
//   with that client, commits. RLS policies from 0001_init.sql key off
//   this setting, so this call is what actually turns the DB-level
//   tenant-isolation guarantee on for a request — not just a nicety.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function withOrgContext<T>(
  orgId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL takes a string literal, not a bind parameter — orgId is a
    // server-generated uuid from a verified session row, never raw user
    // input, so this is not an injection vector. set_config's third arg
    // (is_local) achieves the same as SET LOCAL with parameter binding,
    // which is the safer form when the value's provenance is less certain
    // — used here on principle.
    await client.query(`select set_config('app.current_org_id', $1, true)`, [orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
