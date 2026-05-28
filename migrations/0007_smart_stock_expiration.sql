-- Smart Stock — expiration alerts ("Gerenta IA").
--
-- Adds the stock_movements ledger (entry/exit) with expires_at per batch, plus
-- two cache tables that drive the daily expiration-risk engine:
--   - expiration_risk_cache: snapshot per batch (UPSERTed by cron)
--   - expiration_suggestions: actionable discount proposals with full lifecycle
--
-- stock_movements is created here because legacy code already INSERTs into it
-- (api/pos/sync, api/pos/sales/.../return) but the table was not modelled in
-- MerchantAI yet. The columns superset what those legacy inserts use plus the
-- fields required by the engine (organization_id, unit_cost, remaining_qty,
-- expires_at). IF NOT EXISTS keeps this idempotent against existing prod data.

CREATE TYPE "public"."stock_movement_type" AS ENUM('entry', 'exit', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."expiration_tier" AS ENUM('atencion', 'urgente', 'critico');--> statement-breakpoint
CREATE TYPE "public"."expiration_suggestion_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded', 'expired');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_movements" (
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
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Ensure columns exist even if stock_movements was created by a legacy migration
-- with a narrower shape (current sync route only inserts product_id/name/type/qty/reason/created_by).
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "remaining_qty" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "expires_at" date;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stock_movements_org_product_idx" ON "stock_movements" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_expires_at_idx" ON "stock_movements" USING btree ("organization_id","product_id","expires_at") WHERE "expires_at" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "expiration_risk_cache" (
	"organization_id" text NOT NULL,
	"movement_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "expiration_risk_cache_pk" PRIMARY KEY ("organization_id","movement_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "expiration_risk_cache_product_idx" ON "expiration_risk_cache" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expiration_risk_cache_tier_idx" ON "expiration_risk_cache" USING btree ("organization_id",(("payload"->>'tier')));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "expiration_suggestions" (
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

CREATE INDEX IF NOT EXISTS "expiration_suggestions_movement_idx" ON "expiration_suggestions" USING btree ("organization_id","movement_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expiration_suggestions_pending_idx" ON "expiration_suggestions" USING btree ("organization_id","status") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expiration_suggestions_product_idx" ON "expiration_suggestions" USING btree ("organization_id","product_id","created_at" DESC);
