-- Extend stock_movements with sale/supplier traceability and add
-- stock_max_recommended to products for inventory page thresholds.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stock_max_recommended" integer;--> statement-breakpoint

ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "sale_id" uuid REFERENCES "sales"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "supplier_id" text;
