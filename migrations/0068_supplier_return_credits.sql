-- Supplier return credits: reduces accounts-payable via return stock exits (migration 0068).
--
-- When a return_supplier exit movement is recorded with a supplierId, one or more
-- supplier_payable_credits rows are written (FIFO oldest-first) in the SAME tx as
-- the exit stock_movements insert. This reduces the supplier's outstanding balance
-- (= total_amount − paid_amount − credited_amount) without touching cash.
--
-- Hand-written (not drizzle-kit generated): mirrors 0065 conventions.
-- prod: node scripts/db-migrate.mjs

-- 1. Denormalized credited_amount on supplier_payables (mirrors paid_amount pattern).
--    DEFAULT 0 is safe on existing rows: they have no credits yet.
ALTER TABLE "supplier_payables"
  ADD COLUMN "credited_amount" numeric(12,2) NOT NULL DEFAULT '0';
--> statement-breakpoint

-- 2. Credit ledger table: one row per applied return chunk.
CREATE TABLE "supplier_payable_credits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  -- TEXT (no FK) — mirrors supplier_payables.supplier_id convention (D1).
  "supplier_id" text NOT NULL,
  -- The payable this chunk reduced. SET NULL if payable is ever purged.
  "payable_id" uuid,
  -- The return exit stock_movements row. RESTRICT: must not delete the return
  -- movement while credit rows reference it.
  "return_stock_movement_id" uuid NOT NULL,
  -- Amount applied to THIS payable chunk only.
  "amount" numeric(12,2) NOT NULL,
  "note" text,
  "created_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "supplier_payable_credits"
  ADD CONSTRAINT "supplier_payable_credits_payable_id_fk"
  FOREIGN KEY ("payable_id")
  REFERENCES "supplier_payables"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "supplier_payable_credits"
  ADD CONSTRAINT "supplier_payable_credits_return_stock_movement_id_fk"
  FOREIGN KEY ("return_stock_movement_id")
  REFERENCES "stock_movements"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

-- Indexes.
CREATE INDEX "supplier_payable_credits_org_supplier_idx"
  ON "supplier_payable_credits" ("organization_id", "supplier_id");
--> statement-breakpoint

CREATE INDEX "supplier_payable_credits_payable_idx"
  ON "supplier_payable_credits" ("payable_id");
--> statement-breakpoint

CREATE INDEX "supplier_payable_credits_return_movement_idx"
  ON "supplier_payable_credits" ("return_stock_movement_id");
--> statement-breakpoint

CREATE INDEX "supplier_payable_credits_org_created_idx"
  ON "supplier_payable_credits" ("organization_id", "created_at");
