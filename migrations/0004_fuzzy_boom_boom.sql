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
ALTER TABLE "plan_addons" ADD COLUMN "qty" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_active_per_org_idx" ON "subscriptions" USING btree ("organization_id") WHERE "subscriptions"."active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_org_agent_unique_idx" ON "usage_counters" USING btree ("organization_id","agent_kind");