-- Resync: migration 0049 was silently skipped in production because its journal
-- timestamp (when=1781576793037) is LOWER than 0048's (when=1781700000000, a
-- bogus future date introduced during a parallel-session merge). Drizzle applies
-- a migration only when its folderMillis exceeds the max already recorded, so once
-- 0048 was applied 0049 was treated as "older" and skipped forever — the migrator
-- reports success but treasury_movements.transfer_reconciliation_id never lands.
--
-- This migration re-applies 0049's DDL idempotently and carries a journal
-- timestamp ABOVE 0048's, so it actually runs. Safe to apply where 0049 already
-- succeeded (e.g. local dev): every statement is guarded.
ALTER TABLE "treasury_movements" ADD COLUMN IF NOT EXISTS "transfer_reconciliation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conname = 'treasury_movements_transfer_reconciliation_id_transfer_reconciliations_id_fk'
 ) THEN
  ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_transfer_reconciliation_id_transfer_reconciliations_id_fk" FOREIGN KEY ("transfer_reconciliation_id") REFERENCES "public"."transfer_reconciliations"("id") ON DELETE restrict ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_movements_transfer_recon_unique" ON "treasury_movements" USING btree ("transfer_reconciliation_id");
