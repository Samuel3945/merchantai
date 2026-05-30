-- Reconcilia el drift de products en DBs creadas antes de consolidar el baseline:
-- el baseline usa CREATE TABLE IF NOT EXISTS, así que en una tabla products ya
-- existente NO agrega estas columnas. Idempotente: en DBs nuevas (que ya las
-- traen del baseline) es no-op; en las drifteadas las agrega.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "min_stock" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stock_max_recommended" integer;
