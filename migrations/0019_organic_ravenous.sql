CREATE TYPE "public"."delivery_event_type" AS ENUM('created', 'assigned', 'status_change', 'note', 'customer_notified');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'assigned', 'in_transit', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TABLE "delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_order_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"type" "delivery_event_type" NOT NULL,
	"from_status" "delivery_status",
	"to_status" "delivery_status",
	"note" text,
	"actor_type" "audit_actor_type" DEFAULT 'user' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" uuid,
	"sale_id" uuid,
	"courier_id" uuid,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"customer_name" text,
	"customer_phone" text,
	"address" text NOT NULL,
	"address_notes" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal" numeric(12, 2) DEFAULT '0' NOT NULL,
	"delivery_fee" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"notes" text,
	"assigned_at" timestamp,
	"in_transit_at" timestamp,
	"delivered_at" timestamp,
	"cancelled_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_courier_id_pos_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_events_order_created_idx" ON "delivery_events" USING btree ("delivery_order_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_orders_org_status_created_idx" ON "delivery_orders" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "delivery_orders_org_courier_idx" ON "delivery_orders" USING btree ("organization_id","courier_id");--> statement-breakpoint
CREATE INDEX "delivery_orders_customer_idx" ON "delivery_orders" USING btree ("customer_id");