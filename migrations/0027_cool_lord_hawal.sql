-- session_epoch was already added in migration 0026 (manual); skip it here.
-- Adds employee profile fields: monthly salary, contact phone, and weekly work schedule.
ALTER TABLE "pos_users" ADD COLUMN "salary" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "pos_users" ADD COLUMN "work_schedule" jsonb DEFAULT '{}'::jsonb NOT NULL;
