DROP TABLE "warranty_claims" CASCADE;--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "warranty_type";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "warranty_duration_days";--> statement-breakpoint
ALTER TABLE "sale_items" DROP COLUMN "warranty_type";--> statement-breakpoint
ALTER TABLE "sale_items" DROP COLUMN "warranty_duration_days";--> statement-breakpoint
ALTER TABLE "sale_items" DROP COLUMN "warranty_ends_at";--> statement-breakpoint
DROP TYPE "public"."warranty_claim_status";--> statement-breakpoint
DROP TYPE "public"."warranty_claim_type";--> statement-breakpoint
DROP TYPE "public"."warranty_type";