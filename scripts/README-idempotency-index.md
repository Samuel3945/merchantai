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

## Do NOT use drizzle-kit for this index

Migrations in this repo are **hand-written and journal-registered**. Do NOT run
`drizzle-kit generate` or `drizzle-kit push` against the frozen baseline to
(re)create this index: `generate` would also emit the pre-existing 0050→0062
snapshot drift, and `push` would build the index non-concurrently (a write lock
on the high-write `sales` table). In production this partial UNIQUE index ships
ONLY via the CONCURRENTLY runbook below. The Drizzle schema declares the index
for documentation and isolated dev/test DBs, not for migration generation.

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

The application code uses a pre-SELECT dedupe check (belt). This makes
**sequential** retries exactly-once (the common case: a device re-sending the
same sale after a timeout). It is the ONLY protection until the index is built.

⚠️ **Until `indisvalid = true`, TRUE-CONCURRENT double-submits are NOT
protected.** Two requests with the same key that both pass the pre-SELECT before
either commits will BOTH insert → two sales, double stock decrement, double cash.
The partial UNIQUE index (suspenders) + the 23505 catch is what closes that race.

Therefore treat Step 2 as part of the SAME release as Step 1 — do not leave
devices emitting idempotency keys for an extended window with no valid index, and
prefer a single low-traffic maintenance window so the gap between column and index
is minimal. The pre-SELECT keeps single-flight correct in the meantime, not
concurrent correctness.
