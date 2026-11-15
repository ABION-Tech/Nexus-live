// Session 60 (C-03) — checks that only a real Postgres can make.
//
// Every other test in this repo mocks the database, so nothing ever ran a
// query as the app's own role. That is how 0043's missing grant reached
// production: every scheduled automation failed with "permission denied"
// while all tests passed. These tests run against a freshly migrated
// database, as the same two roles production uses:
//   ADMIN — the migration owner (MIGRATION_DATABASE_URL);
//   APP   — nexus_app, RLS-bound, what the API connects as (DATABASE_URL).
//
// Skipped unless INTEGRATION_DATABASE_URL and INTEGRATION_APP_DATABASE_URL
// are set (CI's "database" job sets both). Never point them at production:
// the isolation test writes and deletes two throwaway companies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const ADMIN_URL = process.env.INTEGRATION_DATABASE_URL;
const APP_URL = process.env.INTEGRATION_APP_DATABASE_URL;

/** Tables with an org_id that are deliberately outside per-company RLS:
 * read by the signed-in user across companies, never by company context. */
const ACCOUNT_LEVEL = new Set(['sessions', 'personal_api_keys']);

describe.skipIf(!ADMIN_URL || !APP_URL)('database (real Postgres)', () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  const A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const B = '0b0b0b0b-0000-4000-8000-00000000000b';

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    app = new pg.Pool({ connectionString: APP_URL });
    await admin.query(`delete from tasks where org_id in ($1, $2)`, [A, B]);
    await admin.query(`delete from organizations where id in ($1, $2)`, [A, B]);
    await admin.query(`insert into organizations (id, name) values ($1, 'Isolation A'), ($2, 'Isolation B')`, [A, B]);
    await admin.query(`insert into tasks (org_id, title) values ($1, 'A only'), ($2, 'B only')`, [A, B]);
  });

  afterAll(async () => {
    await admin.query(`delete from audit_log where org_id in ($1, $2)`, [A, B]);
    await admin.query(`delete from tasks where org_id in ($1, $2)`, [A, B]);
    await admin.query(`delete from organizations where id in ($1, $2)`, [A, B]);
    await admin.end();
    await app.end();
  });

  /** Runs fn as nexus_app with one company's context, like withOrgContext. */
  async function asCompany<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('begin');
      if (orgId) await c.query(`select set_config('app.current_org_id', $1, true)`, [orgId]);
      return await fn(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('the app connects as an RLS-bound role, not a superuser', async () => {
    const { rows } = await app.query(`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('every company table has row-level security enabled, forced, and a policy', async () => {
    const { rows } = await admin.query<{ relname: string; on: boolean; forced: boolean; policies: number }>(`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)`);
    const bad = rows.filter((r) => !ACCOUNT_LEVEL.has(r.relname) && !(r.on && r.forced && r.policies > 0)).map((r) => r.relname);
    expect(rows.length).toBeGreaterThan(30);
    expect(bad).toEqual([]);
  });

  it("every nexus_bootstrap function can read the tables it names (the 0043 bug)", async () => {
    const { rows } = await admin.query<{ fn: string; tbl: string }>(`
      with f as (select p.proname, p.prosrc from pg_proc p join pg_roles r on r.oid = p.proowner
                  where r.rolname = 'nexus_bootstrap' and p.prosecdef),
           t as (select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind = 'r')
      select f.proname as fn, t.relname as tbl from f join t on f.prosrc ~* ('\\m' || t.relname || '\\M')
       where not has_table_privilege('nexus_bootstrap', t.oid, 'select')`);
    expect(rows).toEqual([]);
  });

  it('the scheduler can list which companies have an automation on', async () => {
    const { rows } = await app.query(`select org_id from list_orgs_with_automation_enabled('daily_overdue_check')`);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("a company sees only its own tasks, and nothing without a company", async () => {
    const seenByA = await asCompany(A, async (c) => (await c.query(`select title from tasks where org_id in ($1, $2)`, [A, B])).rows);
    const seenByB = await asCompany(B, async (c) => (await c.query(`select title from tasks where org_id in ($1, $2)`, [A, B])).rows);
    const seenByNone = await asCompany(null, async (c) => (await c.query(`select count(*)::int as n from tasks`)).rows[0].n);
    expect(seenByA).toEqual([{ title: 'A only' }]);
    expect(seenByB).toEqual([{ title: 'B only' }]);
    expect(seenByNone).toBe(0);
  });

  it('a Paystack event is claimed for processing exactly once (C-05)', async () => {
    const key = `test.event:${Date.now()}:${Math.random()}`;
    const claim = async () =>
      (await app.query(`select is_new, claimed from claim_billing_event(null, 'test.event', $1, '{}'::jsonb)`, [key])).rows[0];
    try {
      expect(await claim()).toEqual({ is_new: true, claimed: true });
      // A retry while the first is still being applied: recorded, not claimed.
      expect(await claim()).toEqual({ is_new: false, claimed: false });
      // Two simultaneous deliveries of a new event: only one may apply it.
      const key2 = `${key}:race`;
      const both = await Promise.all([1, 2].map(() => app.query(`select claimed from claim_billing_event(null, 'test.event', $1, '{}'::jsonb)`, [key2])));
      expect(both.map((r) => r.rows[0].claimed).sort()).toEqual([false, true]);
      // Applied successfully: no retry ever re-claims it.
      const { rows } = await admin.query(`select id from billing_events where provider_event_id = $1`, [key]);
      await app.query(`select mark_billing_event_processed($1, true, null)`, [rows[0].id]);
      await admin.query(`update billing_events set processing_started_at = now() - interval '1 hour' where id = $1`, [rows[0].id]);
      expect((await claim()).claimed).toBe(false);
      // A failed attempt older than 5 minutes may be retried.
      await admin.query(`update billing_events set processed = false where id = $1`, [rows[0].id]);
      expect((await claim()).claimed).toBe(true);
    } finally {
      await admin.query(`delete from billing_events where provider_event_id like $1`, [`${key}%`]);
    }
  });

  it('task history is written and read back inside the company only (C-12)', async () => {
    process.env.DATABASE_URL = APP_URL;
    const { recordTaskEvent, listTaskHistory } = await import('./services/taskHistoryService.js');
    const { rows } = await admin.query<{ id: string }>(`select id from tasks where org_id = $1 limit 1`, [A]);
    const taskId = rows[0]!.id;
    const asA = { userId: undefined, orgId: A } as unknown as Parameters<typeof recordTaskEvent>[0];
    await recordTaskEvent(asA, taskId, 'task.updated', { previous: { status: 'not_started' }, next: { status: 'done' } });
    const mine = await listTaskHistory(A, taskId);
    expect(mine[0]).toMatchObject({ action: 'task.updated', previous: { status: 'not_started' }, next: { status: 'done' } });
    expect(await listTaskHistory(B, taskId)).toEqual([]);
    await admin.query(`delete from audit_log where resource_id = $1`, [taskId]);
  });

  it("a company can't write into another company", async () => {
    await expect(asCompany(A, (c) => c.query(`insert into tasks (org_id, title) values ($1, 'smuggled')`, [B]))).rejects.toThrow(/row-level security/);
    const changed = await asCompany(A, async (c) => (await c.query(`update tasks set title = 'hijacked' where org_id = $1`, [B])).rowCount);
    expect(changed).toBe(0);
  });
});
