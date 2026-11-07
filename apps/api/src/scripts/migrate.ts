// Applies database/migrations/*.sql, in filename order, against
// DATABASE_URL — whatever that points to. Tracks applied files in a
// schema_migrations table so re-running is a no-op for files already run.
//
// Deliberately plain `pg` + raw SQL files, no migration framework: the
// PRD's DECISIONS.md already establishes hand-written SQL as the source
// of truth for schema (RLS policies in particular need to be readable as
// real SQL, not generated from an ORM's abstraction). This script's only
// job is "run each file once, in order" — Supabase Cloud, this repo's
// own docker-compose Postgres, and a self-hosted VPS all take the exact
// same DATABASE_URL shape, so this script doesn't know or care which one
// it's talking to.
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src/scripts -> repo root -> database/migrations
const MIGRATIONS_DIR = join(__dirname, '../../../../database/migrations');

async function main() {
  // Deliberately its own connection string, not DATABASE_URL: 0001_init.sql's
  // `create role nexus_app ... login` (and every later migration's DDL)
  // needs a role that can create roles/functions — i.e. the Postgres
  // superuser/bootstrap role, not the RLS-restricted `nexus_app` role
  // DATABASE_URL is meant to hold for the running app (DECISIONS.md §3:
  // "RLS has no effect on superuser/BYPASSRLS roles, so the connection
  // role matters as much as the policy itself"). Falls back to
  // DATABASE_URL for anyone who hasn't split the two yet, so this isn't
  // a breaking change to existing .env files — but see .env.example's
  // own note on why splitting them is what actually makes RLS mean
  // anything once the app itself is running.
  const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!migrationUrl) {
    console.error(
      'Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set. Copy apps/api/.env.example to .env and fill it in.'
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: migrationUrl });
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      )
    `);

    const { rows: appliedRows } = await client.query<{ filename: string }>('select filename from schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // filenames are zero-padded (0001_..., 0002_...) — lexical sort is correct order

    let ranCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`Applying ${file}...`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        ranCount++;
      } catch (err) {
        await client.query('rollback');
        console.error(`Failed on ${file}:`);
        throw err;
      }
    }

    console.log(ranCount === 0 ? 'Already up to date.' : `Applied ${ranCount} migration(s).`);

    // Production hosting (Railway): 0001_init.sql creates nexus_app with a
    // placeholder password. When NEXUS_APP_DB_PASSWORD is set, (re)apply it
    // here, every deploy, before the app starts, so the placeholder is
    // never what the running app authenticates with and the real password
    // lives only in the host's secret store. ALTER ROLE can't take bind
    // parameters, hence format(%L) for safe literal quoting.
    const appRolePassword = process.env.NEXUS_APP_DB_PASSWORD;
    if (appRolePassword) {
      const { rows } = await client.query<{ stmt: string }>(
        `select format('alter role nexus_app with login password %L', $1::text) as stmt`,
        [appRolePassword],
      );
      await client.query(rows[0]!.stmt);
      console.log('nexus_app password applied from NEXUS_APP_DB_PASSWORD.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
