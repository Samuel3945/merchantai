CREATE TYPE "public"."pos_return_reason" AS ENUM('wrong_product', 'damaged', 'customer_request', 'price_error', 'duplicate', 'other');--> statement-breakpoint
CREATE TABLE "pos_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"reason" "pos_return_reason" NOT NULL,
	"notes" text,
	"total_refunded" numeric(12, 2) DEFAULT '0' NOT NULL,
	"refund_method" text NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"cashier_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_item_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"qty" integer NOT NULL,
	"refund_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"restock" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_cashier_id_pos_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_items" ADD CONSTRAINT "pos_return_items_return_id_pos_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."pos_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_items" ADD CONSTRAINT "pos_return_items_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_returns_org_created_idx" ON "pos_returns" USING btree ("organization_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "pos_returns_sale_id_idx" ON "pos_returns" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "pos_return_items_return_id_idx" ON "pos_return_items" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "pos_return_items_sale_item_id_idx" ON "pos_return_items" USING btree ("sale_item_id");
