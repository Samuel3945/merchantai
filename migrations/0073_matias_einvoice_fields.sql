-- MATIAS e-invoicing (replaces Factus): result + credit columns on the emissions
-- trail, and MATIAS as the default provider. Idempotent so a re-run is safe.
ALTER TABLE "einvoice_emissions" ADD COLUMN IF NOT EXISTS "dian_status" text;--> statement-breakpoint
ALTER TABLE "einvoice_emissions" ADD COLUMN IF NOT EXISTS "pdf_url" text;--> statement-breakpoint
ALTER TABLE "einvoice_emissions" ADD COLUMN IF NOT EXISTS "xml_url" text;--> statement-breakpoint
ALTER TABLE "einvoice_emissions" ADD COLUMN IF NOT EXISTS "credits_consumed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "einvoice_emissions" ALTER COLUMN "provider" SET DEFAULT 'matias';
