CREATE TABLE "einvoice_emissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"kind" text DEFAULT 'invoice' NOT NULL,
	"provider" text DEFAULT 'factus' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"cufe" text,
	"number" text,
	"customer" jsonb,
	"payload" jsonb,
	"response" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"emitted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "einvoice_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "einvoice_cufe" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "einvoice_number" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "einvoice_id" uuid;--> statement-breakpoint
ALTER TABLE "einvoice_emissions" ADD CONSTRAINT "einvoice_emissions_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "einvoice_emissions_org_sale_idx" ON "einvoice_emissions" USING btree ("organization_id","sale_id");--> statement-breakpoint
CREATE INDEX "einvoice_emissions_sale_kind_created_idx" ON "einvoice_emissions" USING btree ("sale_id","kind","created_at");