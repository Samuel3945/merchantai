-- Phase 3: FK columns, indexes, and CHECK rewrite for the handover flow.
-- Runs after migration 0052 (which adds the 'transito' and 'handover' enum
-- values).
--
-- IMPORTANT: drizzle-orm's node-postgres migrator runs ALL pending migrations
-- inside ONE transaction (PgDialect.migrate wraps everything in a single
-- session.transaction). So 0052 and 0053 commit together, NOT separately — the
-- earlier ADR-2 assumption ("each file is its own transaction") was wrong and is
-- exactly what broke prod: using the freshly-added enum value 'handover' as an
-- ENUM LITERAL in this same transaction raises 55P04 "unsafe use of new value".
-- Fix: compare type::text against string literals in the CHECK. Text comparison
-- never coerces 'handover' to the enum type, so it is safe in the same tx; the
-- value is still added by 0052 and used as a real enum at runtime (later txns).
-- Statements are idempotent so a re-run (or a manual hotfix) cannot fail.
ALTER TABLE "treasury_movements" ADD COLUMN IF NOT EXISTS "handover_movement_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD COLUMN IF NOT EXISTS "cash_session_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_movements" DROP CONSTRAINT IF EXISTS "treasury_movements_handover_movement_id_fk";--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_handover_movement_id_fk"
  FOREIGN KEY ("handover_movement_id") REFERENCES "public"."treasury_movements"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" DROP CONSTRAINT IF EXISTS "treasury_movements_cash_session_id_fk";--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_cash_session_id_fk"
  FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_movements_handover_idx" ON "treasury_movements" USING btree ("handover_movement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_movements_session_idx" ON "treasury_movements" USING btree ("cash_session_id");--> statement-breakpoint
-- Rewrite the one-sided CHECK to permit type='handover' (from=null, to=transito).
-- DROP + ADD because PostgreSQL has no ALTER CONSTRAINT for CHECK predicates.
-- Constraint name from migration 0046 is "treasury_mov_one_external" (NOT "treasury_movements_*").
-- type::text avoids the 55P04 "unsafe use of new value" error (see header).
ALTER TABLE "treasury_movements" DROP CONSTRAINT IF EXISTS "treasury_mov_one_external";--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_mov_one_external" CHECK (
  num_nonnulls(from_account_id, to_account_id) = 2
  OR (
    num_nonnulls(from_account_id, to_account_id) = 1
    AND type::text IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
  )
);
