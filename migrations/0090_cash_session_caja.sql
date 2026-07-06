-- Fase 2: el arqueo (cash_sessions) cuelga de la CAJA, no del dispositivo.
--
-- Antes: una sesión abierta por dispositivo (pos_token). Con cajas compartidas
-- (2+ dispositivos en la misma bolsa) eso daría 2 arqueos para un mismo cajón.
-- Ahora la sesión se ata a la caja: los dispositivos que comparten caja comparten
-- UNA sola sesión → uno abre, uno cierra, y las ventas de ambos caen en el mismo
-- arqueo. Para cajas individuales (1 dispositivo ↔ 1 caja) el comportamiento es
-- idéntico al anterior.
--
-- No destructivo: backfill de caja_id desde el dispositivo de cada sesión.
ALTER TABLE "cash_sessions" ADD COLUMN "caja_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_caja_id_cajas_id_fk" FOREIGN KEY ("caja_id") REFERENCES "public"."cajas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "cash_sessions" cs SET "caja_id" = pt."caja_id"
  FROM "pos_tokens" pt
  WHERE cs."pos_token_id" = pt."id" AND cs."caja_id" IS NULL;--> statement-breakpoint
CREATE INDEX "cash_sessions_caja_idx" ON "cash_sessions" USING btree ("organization_id","caja_id");--> statement-breakpoint
-- Reemplaza "una abierta por dispositivo" por "una abierta por caja". Para cajas
-- 1:1 es equivalente; para compartidas evita dos arqueos del mismo cajón.
DROP INDEX IF EXISTS "cash_sessions_one_open_per_token_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open_per_caja_idx" ON "cash_sessions" USING btree ("organization_id","caja_id") WHERE "status" = 'open' AND "caja_id" IS NOT NULL;
