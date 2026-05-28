CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"document_id" text,
	"whatsapp" text,
	"email" text,
	"address" text,
	"notes" text,
	"marketing_opt_in" boolean DEFAULT true NOT NULL,
	"total_spent" numeric(14, 2) DEFAULT '0' NOT NULL,
	"last_purchase_at" timestamp,
	"created_by" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_document_unique_idx" ON "customers" USING btree ("organization_id","document_id") WHERE "customers"."document_id" IS NOT NULL AND "customers"."deleted" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_whatsapp_unique_idx" ON "customers" USING btree ("organization_id","whatsapp") WHERE "customers"."whatsapp" IS NOT NULL AND "customers"."deleted" = false;--> statement-breakpoint
CREATE INDEX "customers_org_name_idx" ON "customers" USING btree ("organization_id","name") WHERE "customers"."deleted" = false;
