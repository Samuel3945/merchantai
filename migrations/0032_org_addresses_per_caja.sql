CREATE TABLE "org_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text,
	"address" text NOT NULL,
	"city" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD COLUMN "address_id" uuid;--> statement-breakpoint
CREATE INDEX "org_addresses_org_idx" ON "org_addresses" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD CONSTRAINT "pos_tokens_address_id_org_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."org_addresses"("id") ON DELETE set null ON UPDATE no action;