CREATE TYPE "public"."category_source" AS ENUM('manual', 'ai', 'auto');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"source" "category_source" DEFAULT 'auto' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"attribute_template" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_slug_unique_idx" ON "categories" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "categories_org_usage_idx" ON "categories" USING btree ("organization_id","usage_count");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: one category row per (org, normalized name) from existing products,
-- counting how many non-deleted products already use it.
INSERT INTO "categories" ("organization_id", "name", "slug", "source", "usage_count")
SELECT
	"organization_id",
	MIN(btrim("category")) AS "name",
	lower(btrim("category")) AS "slug",
	'manual',
	COUNT(*)
FROM "products"
WHERE "category" IS NOT NULL AND btrim("category") <> '' AND "deleted" = false
GROUP BY "organization_id", lower(btrim("category"));--> statement-breakpoint
-- Link each product to its backfilled category by normalized name.
UPDATE "products" "p"
SET "category_id" = "c"."id"
FROM "categories" "c"
WHERE "c"."organization_id" = "p"."organization_id"
	AND "c"."slug" = lower(btrim("p"."category"))
	AND "p"."category" IS NOT NULL
	AND btrim("p"."category") <> '';