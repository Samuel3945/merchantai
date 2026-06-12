ALTER TABLE "products" ADD COLUMN "is_digital" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "digital_limit" integer;