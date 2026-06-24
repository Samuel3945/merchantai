-- Supplier purchase invoice header: groups N purchase-entry payables under one factura.
-- Standalone payables (purchase_id = NULL) are fully back-compatible.
--
-- Design decisions:
--   - supplier_id TEXT (no FK) — mirrors stock_movements.supplier_id (D1).
--   - invoice_number nullable; partial-unique per (org, supplier_id, invoice_number) NOT NULL.
--   - Outstanding/paid computed at read (SUM over payable lines); no header denorm in v1.
--
-- Hand-written (mirrors 0068 conventions). prod: node scripts/db-migrate.mjs

-- 1. Invoice header table.
CREATE TABLE "supplier_purchases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "supplier_id" text NOT NULL,
  "invoice_number" text,
  "purchased_at" timestamp DEFAULT now() NOT NULL,
  "notes" text,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Indexes on the header.
CREATE INDEX "supplier_purchases_org_supplier_idx"
  ON "supplier_purchases" ("organization_id", "supplier_id");
--> statement-breakpoint

CREATE INDEX "supplier_purchases_org_purchased_idx"
  ON "supplier_purchases" ("organization_id", "purchased_at");
--> statement-breakpoint

-- Partial unique: prevents duplicate invoice_number per (org, supplier) when set.
CREATE UNIQUE INDEX "supplier_purchases_org_supplier_invoice_unique"
  ON "supplier_purchases" ("organization_id", "supplier_id", "invoice_number")
  WHERE "invoice_number" IS NOT NULL;
--> statement-breakpoint

-- 2. Add purchase_id (nullable FK) to supplier_payables (migration 0069).
ALTER TABLE "supplier_payables"
  ADD COLUMN "purchase_id" uuid;
--> statement-breakpoint

ALTER TABLE "supplier_payables"
  ADD CONSTRAINT "supplier_payables_purchase_id_fk"
  FOREIGN KEY ("purchase_id")
  REFERENCES "supplier_purchases"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX "supplier_payables_purchase_id_idx"
  ON "supplier_payables" ("purchase_id");
