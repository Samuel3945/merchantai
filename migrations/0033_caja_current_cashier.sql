ALTER TABLE "pos_tokens" ADD COLUMN "current_cashier_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD COLUMN "current_cashier_at" timestamp;--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD CONSTRAINT "pos_tokens_current_cashier_id_pos_users_id_fk" FOREIGN KEY ("current_cashier_id") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;