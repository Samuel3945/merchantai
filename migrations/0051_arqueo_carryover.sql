ALTER TABLE "cash_sessions" ADD COLUMN "opening_expected" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "opening_difference" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD COLUMN "opening_explanation" text;
