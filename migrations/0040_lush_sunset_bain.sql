ALTER TABLE "transfer_reconciliations" ADD COLUMN "cashier_explanation" text;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD COLUMN "cashier_explained_by" text;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD COLUMN "cashier_explained_at" timestamp;