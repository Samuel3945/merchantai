-- payment_methods — per-org catalog of checkout payment methods.
--
-- Replaces the hard-coded list of payment types historically stored as
-- free-form text on sales (cash/transfer/card/credit). New orgs are seeded
-- with the Colombian default set (Efectivo, Nequi, Daviplata, Llave, Tarjeta,
-- Fiado) on first read by listPaymentMethods(). Soft-deletes via active=false
-- so older sales referencing a method by name still resolve.

CREATE TYPE "public"."payment_method_type" AS ENUM('cash', 'transfer', 'card', 'credit', 'other');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "type" "payment_method_type" NOT NULL,
  "icon" text,
  "active" boolean DEFAULT true NOT NULL,
  "start_hour" integer,
  "end_hour" integer,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "description" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payment_methods_org_sort_idx" ON "payment_methods" USING btree ("organization_id","sort_order");
