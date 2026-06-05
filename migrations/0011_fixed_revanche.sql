CREATE TYPE "public"."warranty_claim_status" AS ENUM('pending', 'under_review', 'approved', 'rejected', 'closed');--> statement-breakpoint
CREATE TYPE "public"."warranty_claim_type" AS ENUM('exchange', 'refund', 'repair');--> statement-breakpoint
CREATE TYPE "public"."warranty_type" AS ENUM('none', 'manufacturer', 'store', 'extended');--> statement-breakpoint
CREATE TABLE "warranty_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_item_id" uuid NOT NULL,
	"type" "warranty_claim_type" NOT NULL,
	"status" "warranty_claim_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"resolution" text,
	"notification_id" uuid,
	"created_by" text,
	"resolved_by" text,
	"resolved_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "warranty_type" "warranty_type";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "warranty_duration_days" integer;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "warranty_type" "warranty_type";--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "warranty_duration_days" integer;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "warranty_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warranty_claims_org_status_idx" ON "warranty_claims" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "warranty_claims_sale_idx" ON "warranty_claims" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "warranty_claims_sale_item_idx" ON "warranty_claims" USING btree ("sale_item_id");