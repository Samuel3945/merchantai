-- Supplier accounts-payable tables (migration 0065).
--
-- A purchase entry now creates exactly one supplier_payables header row inside
-- the same transaction as the stock_movements insert (atomic). Paying a supplier
-- debits a treasury container via a treasury_movements salida row and writes one
-- supplier_payments ledger row. No expenses or P&L rows are involved — purchases
-- are ASSETS, not P&L.
--
-- Hand-written (not drizzle-kit generated): regenerating from the frozen baseline
-- would also re-emit pre-existing snapshot drift (see Schema.ts).
--
-- prod: node scripts/db-migrate.mjs

CREATE TYPE "public"."supplier_payable_status" AS ENUM('open','partial','paid');
--> statement-breakpoint

CREATE TABLE "supplier_payables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  -- Stored as TEXT (no FK) to mirror stock_movements.supplier_id convention.
  -- The entry flow supplies a valid suppliers.id uuid-as-text.
  "supplier_id" text NOT NULL,
  -- The entry lot this payable was created for. RESTRICT: the lot must stay.
  "stock_movement_id" uuid,
  "total_amount" numeric(12,2) NOT NULL,
  "paid_amount" numeric(12,2) DEFAULT '0' NOT NULL,
  "status" "supplier_payable_status" DEFAULT 'open' NOT NULL,
  "purchased_at" timestamp DEFAULT now() NOT NULL,
  "notes" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "supplier_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "supplier_id" text NOT NULL,
  -- Nullable: SET NULL if payable is ever purged; future ad-hoc payments may omit.
  "payable_id" uuid,
  -- The salida treasury_movements row. RESTRICT: ledger row must not be orphaned.
  "treasury_movement_id" uuid,
  "amount" numeric(12,2) NOT NULL,
  "note" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "supplier_payables"
  ADD CONSTRAINT "supplier_payables_stock_movement_id_fk"
  FOREIGN KEY ("stock_movement_id")
  REFERENCES "stock_movements"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_payable_id_fk"
  FOREIGN KEY ("payable_id")
  REFERENCES "supplier_payables"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_treasury_movement_id_fk"
  FOREIGN KEY ("treasury_movement_id")
  REFERENCES "treasury_movements"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

-- One payable per entry lot. Idempotent backfill-safe (mirrors fiados_sale_unique_idx).
CREATE UNIQUE INDEX "supplier_payables_stock_movement_unique"
  ON "supplier_payables" ("stock_movement_id")
  WHERE "stock_movement_id" IS NOT NULL;
--> statement-breakpoint

-- Open-list + pendingPayments KPI filter.
CREATE INDEX "supplier_payables_org_status_idx"
  ON "supplier_payables" ("organization_id", "status");
--> statement-breakpoint

-- Per-supplier history.
CREATE INDEX "supplier_payables_org_supplier_idx"
  ON "supplier_payables" ("organization_id", "supplier_id");
--> statement-breakpoint

-- Date-range scans on the open-payables list.
CREATE INDEX "supplier_payables_org_purchased_idx"
  ON "supplier_payables" ("organization_id", "purchased_at");
--> statement-breakpoint

-- paidThisMonth window lookup (mirrors fiado_movements_org_created index).
CREATE INDEX "supplier_payments_org_created_idx"
  ON "supplier_payments" ("organization_id", "created_at");
--> statement-breakpoint

CREATE INDEX "supplier_payments_org_supplier_idx"
  ON "supplier_payments" ("organization_id", "supplier_id");
--> statement-breakpoint

CREATE INDEX "supplier_payments_payable_idx"
  ON "supplier_payments" ("payable_id");
