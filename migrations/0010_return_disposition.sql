CREATE TYPE "public"."pos_return_disposition" AS ENUM('restock', 'damaged', 'warranty', 'discard');--> statement-breakpoint
ALTER TYPE "public"."pos_return_reason" ADD VALUE 'business_error';--> statement-breakpoint
ALTER TYPE "public"."pos_return_reason" ADD VALUE 'warranty';--> statement-breakpoint
ALTER TABLE "pos_return_items" ADD COLUMN "disposition" "pos_return_disposition" DEFAULT 'restock' NOT NULL;