// Runtime database migration runner.
//
// Runs the Drizzle SQL migrations in ./migrations against DATABASE_URL using
// only `drizzle-orm` + `pg` (both production dependencies), so it works inside
// the minimal Next.js standalone image without needing `drizzle-kit`.
import process from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[db-migrate] DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const pool = new Pool({ connectionString });

try {
  const db = drizzle(pool);
  console.warn('[db-migrate] Applying migrations from ./migrations ...');
  await migrate(db, { migrationsFolder: './migrations' });
  console.warn('[db-migrate] Migrations applied successfully.');
} catch (error) {
  console.error('[db-migrate] Migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
