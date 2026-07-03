-- Explicit sale origin: sales.channel replaces inferring the origin from
-- pos_token_id/notes. Every creation path (POS register, dashboard-manual,
-- delivery settlement, WhatsApp-agent orders) now stamps this column so
-- delivery-vs-POS KPIs read a real value instead of a heuristic.
CREATE TYPE "public"."sale_channel" AS ENUM('pos', 'panel', 'delivery', 'agent');--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "channel" "sale_channel" DEFAULT 'pos' NOT NULL;--> statement-breakpoint
-- Backfill existing rows. Order matters: delivery is the most specific and
-- must win over the pos_token_id check (a delivery settlement can carry a
-- pos_token_id when it's cashed into a courier's caja).
UPDATE "sales" SET "channel" = 'delivery' WHERE "id" IN (SELECT "sale_id" FROM "delivery_orders" WHERE "sale_id" IS NOT NULL);--> statement-breakpoint
UPDATE "sales" SET "channel" = 'pos' WHERE "pos_token_id" IS NOT NULL AND "channel" <> 'delivery';--> statement-breakpoint
UPDATE "sales" SET "channel" = 'panel' WHERE "pos_token_id" IS NULL AND "channel" <> 'delivery';
-- NOTE: historical WhatsApp-agent orders cannot be distinguished from POS
-- sales in existing data (both go through the same insert path without a
-- reliable marker), so they backfill as 'pos'. This is acceptable — agent
-- orders are new-ish and going forward every insert stamps channel='agent'
-- explicitly at src/app/api/agent/orders/route.ts.
