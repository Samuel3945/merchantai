-- treasury-sweep-model slice 2: per-caja default sweep destination.
-- Adds a nullable FK on pos_tokens pointing to the treasury_accounts row that
-- should receive the shortfall auto-sweep at caja open. ON DELETE SET NULL
-- means retiring the cofre account degrades gracefully to Pendiente de ubicar
-- (no orphan row, no application error).
--
-- prod: node scripts/db-migrate.mjs
ALTER TABLE "pos_tokens" ADD COLUMN IF NOT EXISTS "default_sweep_destination_account_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_tokens" DROP CONSTRAINT IF EXISTS "pos_tokens_sweep_dest_fk";--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD CONSTRAINT "pos_tokens_sweep_dest_fk"
  FOREIGN KEY ("default_sweep_destination_account_id")
  REFERENCES "public"."treasury_accounts"("id")
  ON DELETE set null ON UPDATE no action;
