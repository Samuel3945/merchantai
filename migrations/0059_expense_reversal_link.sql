-- gasto-treasury-unification remediation (C1): server/DB-side idempotency for
-- gasto corrections.
--
-- Adds a nullable self-FK column reverses_expense_id on expenses. A reversing
-- (negative-amount) correction row sets this to the id of the original expense
-- it cancels. The column — NOT the description string — is the source of truth
-- for "already corrected".
--
-- ON DELETE RESTRICT: an original expense MUST NOT be deleted while a reversal
-- references it (mirrors the expense_id FK precedent from migrations 0048/0058
-- and keeps ADR-3 immutability enforceable at the DB level).
--
-- PARTIAL UNIQUE index: a given original can be reversed AT MOST once. The
-- WHERE NOT NULL clause leaves the column free for the (many) normal expense
-- rows that are not reversals, so two concurrent double-corrections of the same
-- expense collide at the DB instead of both committing a phantom reversal.
--
-- prod: node scripts/db-migrate.mjs
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "reverses_expense_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_reverses_expense_id_fk";--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reverses_expense_id_fk" FOREIGN KEY ("reverses_expense_id") REFERENCES "public"."expenses"("id") ON DELETE RESTRICT ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "expenses_reverses_expense_id_unique" ON "expenses" ("reverses_expense_id") WHERE "reverses_expense_id" IS NOT NULL;
