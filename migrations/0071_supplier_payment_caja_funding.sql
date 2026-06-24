-- Supplier payment caja-funding: allows caja drawer to settle a supplier payable
-- without routing through treasury_movements. Migration adds:
--   1. DROP NOT NULL on treasury_movement_id (treasury-funded stays non-null in practice;
--      DB permits null so caja-funded rows can set it null + fill cash_movement_id).
--   2. ADD cash_movement_id: FK to cash_movements (the caja settle writes one expense
--      cash_movements row per payable chunk instead of a treasury_movements salida).
--   3. ADD CHECK num_nonnulls(treasury_movement_id, cash_movement_id) = 1:
--      exactly one funding source per payment row — enforced at the DB layer.
--   4. Partial index on cash_movement_id for caja-settle lookup (low cardinality; WHERE
--      cash_movement_id IS NOT NULL keeps the index small).
--
-- Hand-written (not drizzle-kit generated). Mirrors 0070 conventions.
-- prod: node scripts/db-migrate.mjs
-- PGLite test DDLs: supplier-invoice-payment.test.ts + treasury-supplier-payment.test.ts

-- 1. Allow treasury_movement_id to be NULL (caja-funded rows will set it NULL).
--    Existing rows already have a non-null value; ALTER only changes the NOT NULL constraint.
ALTER TABLE "supplier_payments" ALTER COLUMN "treasury_movement_id" DROP NOT NULL;
--> statement-breakpoint

-- 2. Add cash_movement_id column: references the expense cash_movements row written
--    by recordCajaPayableSettle. ON DELETE RESTRICT: cannot delete the cash movement
--    while a payment row references it (mirrors treasury_movement_id RESTRICT).
ALTER TABLE "supplier_payments" ADD COLUMN "cash_movement_id" uuid;
--> statement-breakpoint

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_cash_movement_id_fk"
  FOREIGN KEY ("cash_movement_id")
  REFERENCES "cash_movements"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

-- 3. Enforce exactly-one funding source (same idiom as treasury_mov_one_external CHECK
--    which uses num_nonnulls for treasury_movements). This prevents:
--    - a row with BOTH ids set (double-count),
--    - a row with NEITHER id set (dangling payment).
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_funding_source_chk"
  CHECK (num_nonnulls(treasury_movement_id, cash_movement_id) = 1);
--> statement-breakpoint

-- 4. Partial index for caja-settle lookup (audit: which caja movements are settle rows).
--    Not needed for query performance today but useful for audits.
CREATE INDEX "supplier_payments_cash_movement_idx"
  ON "supplier_payments" ("cash_movement_id")
  WHERE "cash_movement_id" IS NOT NULL;
