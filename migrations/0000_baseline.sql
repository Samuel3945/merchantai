CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'cashier', 'system', 'api');--> statement-breakpoint
CREATE TYPE "public"."cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."cash_session_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."employee_invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."expiration_suggestion_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded', 'expired');--> statement-breakpoint
CREATE TYPE "public"."expiration_tier" AS ENUM('atencion', 'urgente', 'critico');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('cash_difference', 'low_stock', 'expiring_soon', 'fiado_overdue', 'sale_alert');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('low', 'mid', 'high');--> statement-breakpoint
CREATE TYPE "public"."organization_plan_tier" AS ENUM('free', 'starter', 'pro', 'business');--> statement-breakpoint
CREATE TYPE "public"."payment_method_type" AS ENUM('cash', 'transfer', 'card', 'credit', 'other');--> statement-breakpoint
CREATE TYPE "public"."pos_return_reason" AS ENUM('wrong_product', 'damaged', 'customer_request', 'price_error', 'duplicate', 'other');--> statement-breakpoint
CREATE TYPE "public"."pos_user_role" AS ENUM('admin', 'cashier', 'employee');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."product_unit_type" AS ENUM('unit', 'kg');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('completed', 'settled', 'cancelled', 'returned');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('entry', 'exit', 'adjustment');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_pk" PRIMARY KEY("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"type" "cash_movement_type" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"authorized_by" text,
	"created_by" text NOT NULL,
	"sale_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"opened_by" text NOT NULL,
	"opening_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"closed_at" timestamp,
	"closed_by" text,
	"expected_amount" numeric(12, 2),
	"counted_amount" numeric(12, 2),
	"difference" numeric(12, 2),
	"status" "cash_session_status" DEFAULT 'open' NOT NULL,
	"notes" text
);
--> statement-breakpoint
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
CREATE TABLE "employee_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "pos_user_role" NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"status" "employee_invitation_status" DEFAULT 'pending' NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_modules" text[] DEFAULT ARRAY['pos']::text[] NOT NULL,
	"can_confirm_transfers" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expiration_risk_cache" (
	"organization_id" text NOT NULL,
	"movement_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "expiration_risk_cache_pk" PRIMARY KEY("organization_id","movement_id")
);
--> statement-breakpoint
CREATE TABLE "expiration_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"movement_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"tier" "expiration_tier" NOT NULL,
	"suggested_pct" numeric(5, 2) NOT NULL,
	"max_safe_pct" numeric(5, 2) NOT NULL,
	"suggested_price" numeric(12, 2) NOT NULL,
	"base_price" numeric(12, 2) NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL,
	"reasoning" text NOT NULL,
	"status" "expiration_suggestion_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"notification_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"severity" "notification_severity" DEFAULT 'mid' NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"plan" "organization_plan_tier" DEFAULT 'free' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
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
CREATE TABLE "plan_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"addon" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "pos_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text DEFAULT 'main' NOT NULL,
	"device_name" text NOT NULL,
	"created_by" text NOT NULL,
	"cashier_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"pin" text DEFAULT '' NOT NULL,
	"role" "pos_user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_modules" text[] DEFAULT ARRAY['pos']::text[] NOT NULL,
	"can_confirm_transfers" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"barcode" text,
	"price" numeric(10, 2) NOT NULL,
	"cost" numeric(10, 2) DEFAULT '0' NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"min_stock" integer DEFAULT 0 NOT NULL,
	"stock_max_recommended" integer,
	"category" text,
	"unit_type" "product_unit_type" DEFAULT 'unit' NOT NULL,
	"is_perishable" boolean DEFAULT false NOT NULL,
	"is_wholesale" boolean DEFAULT false NOT NULL,
	"wholesale_tiers" jsonb,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "product_status" DEFAULT 'published' NOT NULL,
	"publish_at" timestamp,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"qty" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"subtotal" numeric(10, 2) NOT NULL,
	"unit_type" text DEFAULT 'unit' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"bills_paid" jsonb,
	"change_given" numeric(10, 2) DEFAULT '0' NOT NULL,
	"reference" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"payment_type" text DEFAULT 'cash' NOT NULL,
	"status" "sale_status" DEFAULT 'completed' NOT NULL,
	"notes" text,
	"cashier_id" text,
	"pos_token_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text,
	"type" "stock_movement_type" NOT NULL,
	"qty" integer NOT NULL,
	"remaining_qty" integer,
	"unit_cost" numeric(12, 2),
	"expires_at" date,
	"reason" text,
	"created_by" text,
	"sale_id" uuid,
	"supplier_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"plan" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"period_start" timestamp DEFAULT now() NOT NULL,
	"period_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "top_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"amount_cop" numeric(12, 2) DEFAULT '0' NOT NULL,
	"requests_added" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_kind" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"monthly_limit" integer DEFAULT 0 NOT NULL,
	"topped_up" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_cash_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_user_id_pos_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pos_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_items" ADD CONSTRAINT "pos_return_items_return_id_pos_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."pos_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_items" ADD CONSTRAINT "pos_return_items_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_cashier_id_pos_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_user_id_pos_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."pos_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD CONSTRAINT "pos_tokens_cashier_id_pos_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_action_idx" ON "audit_logs" USING btree ("organization_id","action");--> statement-breakpoint
CREATE INDEX "audit_logs_org_entity_idx" ON "audit_logs" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_actor_idx" ON "audit_logs" USING btree ("organization_id","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open_per_org_idx" ON "cash_sessions" USING btree ("organization_id") WHERE "cash_sessions"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_document_unique_idx" ON "customers" USING btree ("organization_id","document_id") WHERE "customers"."document_id" IS NOT NULL AND "customers"."deleted" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_whatsapp_unique_idx" ON "customers" USING btree ("organization_id","whatsapp") WHERE "customers"."whatsapp" IS NOT NULL AND "customers"."deleted" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_invitations_token_unique_idx" ON "employee_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "expiration_risk_cache_product_idx" ON "expiration_risk_cache" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "expiration_suggestions_movement_idx" ON "expiration_suggestions" USING btree ("organization_id","movement_id","status");--> statement-breakpoint
CREATE INDEX "expiration_suggestions_pending_idx" ON "expiration_suggestions" USING btree ("organization_id","status") WHERE "expiration_suggestions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "expiration_suggestions_product_idx" ON "expiration_suggestions" USING btree ("organization_id","product_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_org_created_idx" ON "notifications" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_org_unread_idx" ON "notifications" USING btree ("organization_id","created_at") WHERE "notifications"."read" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_plans_org_unique_idx" ON "organization_plans" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "payment_methods_org_sort_idx" ON "payment_methods" USING btree ("organization_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_tokens_token_unique_idx" ON "pos_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_users_email_unique_idx" ON "pos_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_barcode_unique_idx" ON "products" USING btree ("organization_id","barcode") WHERE "products"."deleted" = false AND "products"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_org_product_idx" ON "stock_movements" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_movements_expires_at_idx" ON "stock_movements" USING btree ("organization_id","product_id","expires_at") WHERE "stock_movements"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_active_per_org_idx" ON "subscriptions" USING btree ("organization_id") WHERE "subscriptions"."active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_org_agent_unique_idx" ON "usage_counters" USING btree ("organization_id","agent_kind");