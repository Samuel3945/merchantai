-- Phase 3: FK columns, indexes, and CHECK rewrite for the handover flow.
-- Runs AFTER migration 0052 (which added the 'transito' and 'handover' enum
-- values). The CHECK constraint references 'handover' — safe here because the
-- new value is already committed in a prior transaction (ADR-2).
ALTER TABLE "treasury_movements" ADD COLUMN "handover_movement_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD COLUMN "cash_session_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_handover_movement_id_fk"
  FOREIGN KEY ("handover_movement_id") REFERENCES "public"."treasury_movements"("id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_cash_session_id_fk"
  FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_movements_handover_idx" ON "treasury_movements" USING btree ("handover_movement_id");--> statement-breakpoint
CREATE INDEX "treasury_movements_session_idx" ON "treasury_movements" USING btree ("cash_session_id");--> statement-breakpoint
-- Rewrite the one-sided CHECK to permit type='handover' (from=null, to=transito).
-- DROP + ADD because PostgreSQL has no ALTER CONSTRAINT for CHECK predicates.
-- Constraint name from migration 0046 is "treasury_mov_one_external" (NOT "treasury_movements_*").
ALTER TABLE "treasury_movements" DROP CONSTRAINT "treasury_mov_one_external";--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_mov_one_external" CHECK (
  num_nonnulls(from_account_id, to_account_id) = 2
  OR (
    num_nonnulls(from_account_id, to_account_id) = 1
    AND type IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
  )
);
