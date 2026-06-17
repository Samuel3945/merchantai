-- Extends transfer_reconciliations for the investigation-resolution flow.
-- Adds the 'resolved' terminal status and the three columns needed for
-- claim tracking, cross-period recovery, and partial-arrival splits.
--
-- NOTE: drizzle-orm's node-postgres migrator wraps all pending migrations in ONE
-- transaction. PostgreSQL 12+ allows ALTER TYPE ADD VALUE inside a transaction,
-- but the new value cannot be USED as an enum literal until commit. The ADD COLUMN
-- statements below use only boolean/uuid types, satisfying that constraint.
-- IF NOT EXISTS on all statements makes this safe to re-run after a failed batch.
ALTER TYPE "public"."transfer_reconciliation_status" ADD VALUE IF NOT EXISTS 'resolved';--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD COLUMN IF NOT EXISTS "claim_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD COLUMN IF NOT EXISTS "recovery_of_id" uuid;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD COLUMN IF NOT EXISTS "remainder_reconciliation_id" uuid;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" DROP CONSTRAINT IF EXISTS "transfer_recon_recovery_of_fk";--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_recon_recovery_of_fk" FOREIGN KEY ("recovery_of_id") REFERENCES "public"."transfer_reconciliations"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" DROP CONSTRAINT IF EXISTS "transfer_recon_remainder_fk";--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_recon_remainder_fk" FOREIGN KEY ("remainder_reconciliation_id") REFERENCES "public"."transfer_reconciliations"("id") ON DELETE set null;
