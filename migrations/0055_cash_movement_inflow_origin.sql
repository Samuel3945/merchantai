-- treasury-sweep-model slice 3: inflows model — origin discriminator + treasury link.
-- Adds two nullable columns to cash_movements:
--   origin: 'internal' | 'external' | null (null = legacy device, backward-compat)
--   treasury_movement_id: FK to treasury_movements.id (set for internal-origin entradas)
--
-- Both columns are nullable so existing rows and legacy POS devices are unaffected.
-- The FK uses SET NULL so removing a treasury_movements row doesn't orphan a
-- cash_movements row (audit trail preserved).
--
-- prod: node scripts/db-migrate.mjs
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "origin" text;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "treasury_movement_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT IF EXISTS "cash_movements_treasury_mov_fk";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_treasury_mov_fk"
  FOREIGN KEY ("treasury_movement_id")
  REFERENCES "public"."treasury_movements"("id")
  ON DELETE set null ON UPDATE no action;
