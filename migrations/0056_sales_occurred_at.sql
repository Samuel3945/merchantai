ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp;--> statement-breakpoint
UPDATE "sales" SET "occurred_at" = "created_at" WHERE "occurred_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "occurred_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "occurred_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_org_status_occurred_idx" ON "sales" USING btree ("organization_id","status","occurred_at");
