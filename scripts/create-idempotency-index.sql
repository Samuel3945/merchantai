-- Runbook: Create the partial unique index for sale_idempotency_key
--
-- PURPOSE
--   Enforce exactly-once mobile sync at the database level. The idempotency
--   key column was added by migration 0062_sale_idempotency_key.sql (nullable,
--   zero-downtime). This index completes the constraint.
--
-- WHY OUT OF BAND (not a Drizzle migration file)
--   Drizzle's prod migrate runner (node scripts/db-migrate.mjs) wraps each
--   migration file in a transaction. PostgreSQL forbids CREATE INDEX CONCURRENTLY
--   inside a transaction — it would error: "CREATE INDEX CONCURRENTLY cannot run
--   inside a transaction block". No existing migration uses CONCURRENTLY for this
--   reason.
--
-- WHEN TO RUN
--   1. Confirm migration 0062 has been deployed and baked on production.
--   2. Run this SQL OUTSIDE a transaction block (psql default: autocommit ON).
--   3. Verify with the query at the bottom before enabling dedupe in app code.
--
-- HOW TO RUN (Easypanel VPS)
--   psql "$DATABASE_URL" -f scripts/create-idempotency-index.sql
--
-- CONCURRENCY SAFETY
--   CONCURRENTLY allows the build to proceed while the table accepts full
--   read/write traffic. No write lock is taken on "sales" beyond a brief
--   catalog update at the start and end.
--
-- IF THE INDEX BUILD FAILS MID-WAY
--   A failed concurrent build leaves an INVALID index. Clean it up with:
--     DROP INDEX CONCURRENTLY IF EXISTS sales_org_idempotency_key_unique_idx;
--   Then re-run this script.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sales_org_idempotency_key_unique_idx
  ON sales (organization_id, sale_idempotency_key)
  WHERE sale_idempotency_key IS NOT NULL;

-- Verify the index is VALID (not "INVALID") before enabling dedupe:
SELECT indexname, indisvalid, indisready
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
WHERE indexrelname = 'sales_org_idempotency_key_unique_idx';
