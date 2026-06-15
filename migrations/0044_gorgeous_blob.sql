CREATE TYPE "public"."treasury_account_type" AS ENUM('caja', 'caja_fuerte', 'banco');--> statement-breakpoint
CREATE TYPE "public"."treasury_movement_type" AS ENUM('transfer', 'consignacion', 'entrada', 'salida', 'gasto', 'adjustment');--> statement-breakpoint
CREATE TABLE "treasury_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"type" "treasury_account_type" NOT NULL,
	"name" text NOT NULL,
	"opening_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"payment_method_id" uuid,
	"pos_token_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_pos_token_id_pos_tokens_id_fk" FOREIGN KEY ("pos_token_id") REFERENCES "public"."pos_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_accounts_org_idx" ON "treasury_accounts" USING btree ("organization_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_accounts_org_name_unique" ON "treasury_accounts" USING btree ("organization_id","name");