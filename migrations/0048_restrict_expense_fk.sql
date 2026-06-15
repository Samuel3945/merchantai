-- W-3 hardening: change expense_id FK on treasury_movements from SET NULL to
-- RESTRICT. An expenses row MUST NOT be deleted while a linked
-- treasury_movements row exists (spec data invariant).
ALTER TABLE "treasury_movements" DROP CONSTRAINT "treasury_movements_expense_id_expenses_id_fk";--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE restrict ON UPDATE no action;
