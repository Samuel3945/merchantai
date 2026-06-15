CREATE TABLE "treasury_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"from_account" text NOT NULL,
	"to_account" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "treasury_transfers_org_idx" ON "treasury_transfers" USING btree ("organization_id");