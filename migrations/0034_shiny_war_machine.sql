DROP INDEX "cash_sessions_one_open_per_org_idx";--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "pos_token_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open_per_token_idx" ON "cash_sessions" USING btree ("organization_id","pos_token_id") WHERE "cash_sessions"."status" = 'open' AND "cash_sessions"."pos_token_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open_admin_idx" ON "cash_sessions" USING btree ("organization_id") WHERE "cash_sessions"."status" = 'open' AND "cash_sessions"."pos_token_id" IS NULL;