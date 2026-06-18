-- gasto-treasury-unification slice 1: POS→P&L bridge.
-- Adds a nullable FK column expense_id to cash_movements that links a POS
-- expense movement to its anchor row in the expenses table (mirrors the
-- existing treasury_movements.expense_id pattern from migration 0048).
--
-- ON DELETE RESTRICT: an expenses row MUST NOT be deleted while a linked
-- cash_movements row exists (same constraint as migration 0048 on
-- treasury_movements). This enforces ADR-3 immutability at the DB level.
--
-- prod: node scripts/db-migrate.mjs
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "expense_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_expense_id_fk";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE RESTRICT ON UPDATE no action;
