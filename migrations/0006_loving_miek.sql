CREATE TYPE "public"."supplier_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"phone" text,
	"email" text,
	"city" text,
	"address" text,
	"tax_id" text,
	"notes" text,
	"status" "supplier_status" DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
CREATE INDEX "suppliers_org_status_idx" ON "suppliers" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_tax_id_idx" ON "suppliers" USING btree ("organization_id","tax_id") WHERE "suppliers"."tax_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_org_supplier_idx" ON "cash_movements" USING btree ("organization_id","supplier_id") WHERE "cash_movements"."supplier_id" IS NOT NULL;