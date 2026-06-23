# Idempotency Key Index — Deploy Runbook

## What

Partial UNIQUE index on `sales(organization_id, sale_idempotency_key) WHERE sale_idempotency_key IS NOT NULL`.
Part of the exactly-once mobile sync contract (PR1, `sdd/merchant-mobile-p1`).

## Deploy order

```
Step 1 (migration — already automated)
  node scripts/db-migrate.mjs
  → Adds nullable "sale_idempotency_key uuid" column to sales.
  → Zero-downtime: metadata-only ALTER on Postgres 11+.

Step 2 (this runbook — manual, AFTER step 1 bakes)
  psql "$DATABASE_URL" -f scripts/create-idempotency-index.sql
  → Builds the partial UNIQUE index concurrently (no write lock).

Step 3 (verify index is VALID before relying on it)
  The script prints a pg_stat_user_indexes row; confirm indisvalid = true.
```

## Why not inside a migration file?

`node scripts/db-migrate.mjs` uses Drizzle's `migrate()` which wraps each
file in a PostgreSQL transaction. `CREATE INDEX CONCURRENTLY` is forbidden
inside a transaction block (Postgres will error). This is a hard Postgres
constraint; there is no workaround other than running CONCURRENTLY outside
a transaction.

## If the build fails mid-way

A failed concurrent build leaves an `INVALID` index. Clean it up:

```sql
DROP INDEX CONCURRENTLY IF EXISTS sales_org_idempotency_key_unique_idx;
```

Then re-run the script.

## What happens before the index exists?

The application code uses a pre-SELECT dedupe check (belt), so correctness
is maintained even while the index is not yet built or is still building.
The index (suspenders) closes the concurrent-retry race window. Both are
needed for the full exactly-once guarantee under concurrent traffic.
