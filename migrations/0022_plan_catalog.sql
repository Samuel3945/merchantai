CREATE TABLE "plan_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_monthly_cop" numeric(12, 2) DEFAULT '0' NOT NULL,
	"price_annual_cop" numeric(12, 2),
	"feature_bullets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_entitlements_plan_key_unique_idx" ON "plan_entitlements" USING btree ("plan_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_slug_unique_idx" ON "plans" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_default_idx" ON "plans" USING btree ("is_default") WHERE "plans"."is_default" = true;