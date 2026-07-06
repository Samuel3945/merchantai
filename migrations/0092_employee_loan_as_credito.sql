-- Employee loan → credito unification — migration 0092.
--
-- A "vale / préstamo a empleado" is now a real credito: the loan is owed BY the
-- employee (credito.employee_id set, customer_id / sale_id null), so it shows in
-- the "Clientes que deben" wall with an "Empleado" badge and is payable from the
-- POS via the crédito abono flow OR a caja abono. The standalone employee_loans /
-- employee_loan_payments tables (migration 0091, one migration old) are dropped.
--
-- Hand-written (not drizzle-kit generated): regenerating from the frozen baseline
-- would also re-emit pre-existing snapshot drift (see Schema.ts).
--
-- prod: node scripts/db-migrate.mjs

ALTER TABLE "creditos" ADD COLUMN "employee_id" uuid;
--> statement-breakpoint

-- SET NULL: archiving a pos_user must never wipe the loan record.
ALTER TABLE "creditos"
  ADD CONSTRAINT "creditos_employee_id_fk"
  FOREIGN KEY ("employee_id")
  REFERENCES "pos_users"("id")
  ON DELETE SET NULL;
--> statement-breakpoint

-- Employee-loan wall + outstanding-loan scans filter org + employee.
CREATE INDEX "creditos_org_employee_idx"
  ON "creditos" ("organization_id", "employee_id");
--> statement-breakpoint

-- The standalone loan model is retired; employee loans live in `creditos` now.
DROP TABLE IF EXISTS "employee_loan_payments";
--> statement-breakpoint

DROP TABLE IF EXISTS "employee_loans";
--> statement-breakpoint

DROP TYPE IF EXISTS "employee_loan_status";
