// Runtime database migration runner.
//
// Runs the Drizzle SQL migrations in ./migrations against DATABASE_URL using
// only `drizzle-orm` + `pg` (both production dependencies), so it works inside
// the minimal Next.js standalone image without needing `drizzle-kit`.
//
// On a fresh deploy the app container can boot before the Postgres service is
// resolvable on the internal Docker network (ENOTFOUND) or accepting
// connections (ECONNREFUSED / "starting up"). A single attempt would crash the
// entrypoint and put the container into a restart loop, so we retry with
// backoff and only give up if the database stays unreachable.
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[db-migrate] DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const MAX_ATTEMPTS = Number(process.env.DB_MIGRATE_MAX_ATTEMPTS ?? 15);
const RETRY_DELAY_MS = Number(process.env.DB_MIGRATE_RETRY_DELAY_MS ?? 2000);

// Connection-level failures that mean "the database isn't ready yet" rather
// than "the migration SQL is wrong". Only these are worth retrying.
const TRANSIENT_CODES = new Set([
  'ENOTFOUND', // internal DNS name not resolvable yet
  'EAI_AGAIN', // transient DNS failure
  'ECONNREFUSED', // server not accepting connections yet
  'ECONNRESET',
  'ETIMEDOUT',
  '57P03', // postgres: the database system is starting up
]);

function isTransient(error) {
  for (let e = error; e; e = e.cause) {
    if (e.code && TRANSIENT_CODES.has(e.code)) {
      return true;
    }
  }
  return false;
}

async function runMigrations() {
  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: './migrations' });
  } finally {
    await pool.end();
  }
}

let lastError;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    console.warn(
      `[db-migrate] Applying migrations from ./migrations (attempt ${attempt}/${MAX_ATTEMPTS}) ...`,
    );
    await runMigrations();
    console.warn('[db-migrate] Migrations applied successfully.');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (isTransient(error) && attempt < MAX_ATTEMPTS) {
      const code = error.cause?.code ?? error.code ?? 'unknown';
      console.warn(
        `[db-migrate] Database not reachable yet (${code}); retrying in ${RETRY_DELAY_MS}ms ...`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    break;
  }
}

console.error('[db-migrate] Migration failed:', lastError);
process.exit(1);
