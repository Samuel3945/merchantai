-- Supplier refund flow: when a returned lot has been fully or partially paid,
-- the supplier owes cash back. This migration adds:
--   1. 'refund' enum value on treasury_movement_type
--   2. DROP+ADD the treasury_mov_one_external CHECK to include 'refund'
--   3. supplier_refunds table: one row per cash-refund event
--
-- 55P04 safety: drizzle-orm's node-postgres migrator runs all pending migrations
-- in ONE transaction. A freshly-added enum value cannot be used as an ENUM LITERAL
-- in the same transaction (55P04 "unsafe use of new value"). This file avoids that
-- by using type::text in the CHECK instead of the enum literal. Same pattern as
-- migrations 0052/0053 (which added 'handover').
--
-- Hand-written (not drizzle-kit generated): mirrors 0053 conventions.
-- prod: node scripts/db-migrate.mjs

-- 1. Add 'refund' to the treasury_movement_type enum.
--    IF NOT EXISTS makes this safe to re-run after a failed batch or manual hotfix.
ALTER TYPE "public"."treasury_movement_type" ADD VALUE IF NOT EXISTS 'refund';
--> statement-breakpoint

-- 2. Rewrite the one-sided CHECK to permit type='refund' (from=null, to=container).
--    DROP + ADD because PostgreSQL has no ALTER CONSTRAINT for CHECK predicates.
--    Constraint name from migration 0046 is "treasury_mov_one_external".
--    type::text avoids the 55P04 "unsafe use of new value" error (see header).
ALTER TABLE "treasury_movements" DROP CONSTRAINT IF EXISTS "treasury_mov_one_external";
--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_mov_one_external" CHECK (
  num_nonnulls(from_account_id, to_account_id) = 2
  OR (
    num_nonnulls(from_account_id, to_account_id) = 1
    AND type::text IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover', 'refund')
  )
);
--> statement-breakpoint

-- 3. Create supplier_refunds: one row per cash-back event from a supplier.
--    Mirrors supplier_payments shape (treasury_movement_id NOT NULL RESTRICT).
--    payable_id is nullable: SET NULL if the payable is ever purged (credit ledger stays).
--    stock_movement_id references the EXIT row of the return (RESTRICT: cannot delete
--    the return movement while a refund row references it).
CREATE TABLE "supplier_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "supplier_id" text NOT NULL,
  "payable_id" uuid,
  "stock_movement_id" uuid NOT NULL,
  "treasury_movement_id" uuid NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "note" text,
  "created_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "supplier_refunds"
  ADD CONSTRAINT "supplier_refunds_payable_id_fk"
  FOREIGN KEY ("payable_id")
  REFERENCES "supplier_payables"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "supplier_refunds"
  ADD CONSTRAINT "supplier_refunds_stock_movement_id_fk"
  FOREIGN KEY ("stock_movement_id")
  REFERENCES "stock_movements"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "supplier_refunds"
  ADD CONSTRAINT "supplier_refunds_treasury_movement_id_fk"
  FOREIGN KEY ("treasury_movement_id")
  REFERENCES "treasury_movements"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

-- Indexes.
CREATE INDEX "supplier_refunds_org_supplier_idx"
  ON "supplier_refunds" ("organization_id", "supplier_id");
--> statement-breakpoint

CREATE INDEX "supplier_refunds_payable_idx"
  ON "supplier_refunds" ("payable_id");
--> statement-breakpoint

CREATE INDEX "supplier_refunds_stock_movement_idx"
  ON "supplier_refunds" ("stock_movement_id");
--> statement-breakpoint

CREATE INDEX "supplier_refunds_org_created_idx"
  ON "supplier_refunds" ("organization_id", "created_at");
