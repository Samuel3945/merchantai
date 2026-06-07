CREATE TYPE "public"."fiado_movement_type" AS ENUM('charge', 'payment', 'extension', 'writeoff', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."fiado_status" AS ENUM('pending', 'paid', 'written_off');--> statement-breakpoint
CREATE TABLE "fiado_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiado_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"type" "fiado_movement_type" NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"method" text,
	"cash_movement_id" uuid,
	"due_date_before" date,
	"due_date_after" date,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" uuid,
	"sale_id" uuid,
	"original_amount" numeric(12, 2) NOT NULL,
	"due_date" date NOT NULL,
	"status" "fiado_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fiado_movements" ADD CONSTRAINT "fiado_movements_fiado_id_fiados_id_fk" FOREIGN KEY ("fiado_id") REFERENCES "public"."fiados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiado_movements" ADD CONSTRAINT "fiado_movements_cash_movement_id_cash_movements_id_fk" FOREIGN KEY ("cash_movement_id") REFERENCES "public"."cash_movements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiados" ADD CONSTRAINT "fiados_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiados" ADD CONSTRAINT "fiados_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fiado_movements_fiado_created_idx" ON "fiado_movements" USING btree ("fiado_id","created_at");--> statement-breakpoint
CREATE INDEX "fiado_movements_org_type_created_idx" ON "fiado_movements" USING btree ("organization_id","type","created_at");--> statement-breakpoint
CREATE INDEX "fiados_org_status_idx" ON "fiados" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "fiados_org_due_date_idx" ON "fiados" USING btree ("organization_id","due_date");--> statement-breakpoint
CREATE INDEX "fiados_customer_idx" ON "fiados" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fiados_sale_unique_idx" ON "fiados" USING btree ("sale_id") WHERE "fiados"."sale_id" IS NOT NULL;