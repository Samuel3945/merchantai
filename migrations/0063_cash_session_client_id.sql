-- Add client_session_id to cash_sessions for offline-authoritative open/close.
--
-- The mobile device generates a UUID v4 when it opens a cash session offline.
-- The server uses it to deduplicate replays (idempotent open: re-sending the
-- same client_session_id returns the existing session) and to reconcile a
-- concurrent server-side open for the same caja.
--
-- Nullable so legacy/admin sessions (opened from the dashboard, web POS) keep
-- working unchanged — they submit no client_session_id and stay NULL.
--
-- Unlike sales (high-write → CONCURRENTLY out of band), cash_sessions is
-- low-write, so the partial UNIQUE index ships INSIDE this transactional
-- migration: a plain CREATE UNIQUE INDEX takes only a brief lock on a small
-- table. The partial predicate keeps the many NULL (legacy/admin) rows valid.
--
-- prod: node scripts/db-migrate.mjs
ALTER TABLE "cash_sessions" ADD COLUMN "client_session_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_org_client_session_idx" ON "cash_sessions" ("organization_id","client_session_id") WHERE "client_session_id" IS NOT NULL;
