-- Employee loans (vale / préstamo a empleado) — migration 0091.
--
-- Modeled on supplier_payables (migration 0065): a loan header with a
-- denormalized paid_amount + status, plus a payments ledger (one row per abono).
--
-- A loan is FUNDED by an `advance` cash_movements salida (money leaves the drawer
-- to the employee) and REPAID by `deposit` cash_movements entradas (cash back
-- into the drawer). No expenses / P&L rows are involved — a loan is a receivable
-- against the employee, not a cost.
--
-- Hand-written (not drizzle-kit generated): regenerating from the frozen baseline
-- would also re-emit pre-existing snapshot drift (see Schema.ts).
--
-- prod: node scripts/db-migrate.mjs

CREATE TYPE "public"."employee_loan_status" AS ENUM('open','partial','paid');
--> statement-breakpoint

CREATE TABLE "employee_loans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  -- The employee who received the loan. RESTRICT: the person must not be deleted
  -- while a loan exists on record.
  "employee_id" uuid NOT NULL,
  -- Name snapshot at creation (survives a rename / soft-archive of the person).
  "borrower_name" text,
  "total_amount" numeric(12,2) NOT NULL,
  "paid_amount" numeric(12,2) DEFAULT '0' NOT NULL,
  "status" "employee_loan_status" DEFAULT 'open' NOT NULL,
  -- The advance cash_movements row that funded this loan. SET NULL keeps the loan.
  "cash_movement_id" uuid,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "employee_loan_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "employee_id" uuid NOT NULL,
  -- The loan this abono paid down. SET NULL if a loan is ever purged.
  "loan_id" uuid,
  -- The deposit cash_movements row for this abono. SET NULL keeps the ledger row.
  "cash_movement_id" uuid,
  "treasury_movement_id" uuid,
  "amount" numeric(12,2) NOT NULL,
  "note" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "employee_loans"
  ADD CONSTRAINT "employee_loans_employee_id_fk"
  FOREIGN KEY ("employee_id")
  REFERENCES "pos_users"("id")
  ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "employee_loans"
  ADD CONSTRAINT "employee_loans_cash_movement_id_fk"
  FOREIGN KEY ("cash_movement_id")
  REFERENCES "cash_movements"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "employee_loan_payments"
  ADD CONSTRAINT "employee_loan_payments_loan_id_fk"
  FOREIGN KEY ("loan_id")
  REFERENCES "employee_loans"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "employee_loan_payments"
  ADD CONSTRAINT "employee_loan_payments_cash_movement_id_fk"
  FOREIGN KEY ("cash_movement_id")
  REFERENCES "cash_movements"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- Per-employee loan history.
CREATE INDEX "employee_loans_org_employee_idx"
  ON "employee_loans" ("organization_id", "employee_id");
--> statement-breakpoint

-- Open-list + outstanding KPI filter.
CREATE INDEX "employee_loans_org_status_idx"
  ON "employee_loans" ("organization_id", "status");
--> statement-breakpoint

-- Date-range scans on the loans list.
CREATE INDEX "employee_loans_org_created_idx"
  ON "employee_loans" ("organization_id", "created_at");
--> statement-breakpoint

-- Abonos for a given loan.
CREATE INDEX "employee_loan_payments_loan_idx"
  ON "employee_loan_payments" ("loan_id");
--> statement-breakpoint

CREATE INDEX "employee_loan_payments_org_idx"
  ON "employee_loan_payments" ("organization_id");
