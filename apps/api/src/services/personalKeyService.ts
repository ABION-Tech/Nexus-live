// Session 56 — personal API keys (0039_personal_api_keys.sql).
//
// A person creates a key so another app of theirs can read their own
// Nexus work — first use: Synergia pulling "my tasks" into its planner.
// The key is shown once; only its SHA-256 is stored. A key acts as one
// person in one organization and only for its scopes ('tasks:read').
import crypto from 'node:crypto';
import { pool, withOrgContext } from '../db.js';

export const KEY_PREFIX = 'nxk_';
export const MAX_ACTIVE_KEYS = 10;
export type KeyScope = 'tasks:read';

export interface PersonalKey {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface KeyIdentity {
  keyId: string;
  userId: string;
  orgId: string;
  scopes: KeyScope[];
}

export class PersonalKeyError extends Error {
  constructor(public code: 'bad_name' | 'too_many', message: string) {
    super(message);
    this.name = 'PersonalKeyError';
  }
}

const hash = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  created_at: Date;
  last_used_at: Date | null;
}
const toKey = (r: KeyRow): PersonalKey => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
});

export async function listKeys(userId: string): Promise<PersonalKey[]> {
  const { rows } = await pool.query<KeyRow>(
    `select id, name, prefix, scopes, created_at, last_used_at
       from personal_api_keys
      where user_id = $1 and revoked_at is null
      order by created_at desc`,
    [userId]
  );
  return rows.map(toKey);
}

/** Creates a key. The returned `secret` is the only time it exists in full. */
export async function createKey(userId: string, orgId: string, name: unknown): Promise<{ key: PersonalKey; secret: string }> {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean.length < 1 || clean.length > 60) throw new PersonalKeyError('bad_name', 'Give the key a name of up to 60 characters, like "Synergia".');
  const { rows: count } = await pool.query<{ n: number }>(
    `select count(*)::int as n from personal_api_keys where user_id = $1 and revoked_at is null`,
    [userId]
  );
  if ((count[0]?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new PersonalKeyError('too_many', `You already have ${MAX_ACTIVE_KEYS} keys. Revoke one you no longer use first.`);
  }
  const secret = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const prefix = secret.slice(0, 12);
  const { rows } = await pool.query<KeyRow>(
    `insert into personal_api_keys (user_id, org_id, name, prefix, key_hash)
     values ($1, $2, $3, $4, $5)
     returning id, name, prefix, scopes, created_at, last_used_at`,
    [userId, orgId, clean, prefix, hash(secret)]
  );
  return { key: toKey(rows[0]!), secret };
}

/** Revokes one of the caller's own keys. Returns false if it isn't theirs or is already revoked. */
export async function revokeKey(userId: string, keyId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(keyId)) return false;
  const { rowCount } = await pool.query(
    `update personal_api_keys set revoked_at = now()
      where id = $1 and user_id = $2 and revoked_at is null`,
    [keyId, userId]
  );
  return (rowCount ?? 0) > 0;
}

/** Resolves a raw key to who it acts as, or null. Also stamps last_used_at
 * (at most once a minute, so a busy integration doesn't write every call). */
export async function verifyKey(raw: string): Promise<KeyIdentity | null> {
  if (!raw.startsWith(KEY_PREFIX) || raw.length < 40 || raw.length > 80) return null;
  const { rows } = await pool.query<{ id: string; user_id: string; org_id: string; scopes: KeyScope[] }>(
    `select id, user_id, org_id, scopes
       from personal_api_keys
      where key_hash = $1 and revoked_at is null`,
    [hash(raw)]
  );
  const row = rows[0];
  if (!row) return null;
  // A person removed from the organization loses what their keys could
  // read. org_memberships is RLS-protected, so check inside that org.
  const stillMember = await withOrgContext(row.org_id, async (client) => {
    const r = await client.query(`select 1 from org_memberships where user_id = $1 and org_id = $2`, [row.user_id, row.org_id]);
    return (r.rowCount ?? 0) > 0;
  });
  if (!stillMember) return null;
  await pool.query(
    `update personal_api_keys set last_used_at = now()
      where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [row.id]
  );
  return { keyId: row.id, userId: row.user_id, orgId: row.org_id, scopes: row.scopes };
}
