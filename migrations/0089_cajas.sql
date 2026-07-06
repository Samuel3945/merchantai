-- "Caja" como bolsa de dinero LÓGICA, separada del dispositivo POS.
--
-- Hasta ahora "caja" y "dispositivo" eran lo mismo (cash_sessions.pos_token_id).
-- Ahora se separan: un dispositivo (pos_tokens) apunta a UNA caja; una caja puede
-- tener 1 dispositivo (individual) o VARIOS (compartida = misma bolsa, varias
-- pantallas). Una caja tipo 'courier' pertenece a un domiciliario (su saldo se
-- deriva del ledger courier_cash_movements). Ver docs/caja-domiciliario.
--
-- Regla de préstamos: se presta entre cajas DISTINTAS; dentro de una misma caja
-- (los POS que la comparten) no hay préstamo — es una sola bolsa.
--
-- No destructivo: backfill crea una caja individual por cada dispositivo actual.
CREATE TYPE "caja_type" AS ENUM('register', 'courier');--> statement-breakpoint
CREATE TABLE "cajas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "caja_type" DEFAULT 'register' NOT NULL,
	"courier_id" uuid,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "cajas" ADD CONSTRAINT "cajas_courier_id_pos_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."pos_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD COLUMN "caja_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD CONSTRAINT "pos_tokens_caja_id_cajas_id_fk" FOREIGN KEY ("caja_id") REFERENCES "public"."cajas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cajas_org_idx" ON "cajas" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cajas_one_active_per_courier_idx" ON "cajas" USING btree ("organization_id","courier_id") WHERE "courier_id" IS NOT NULL AND "archived" = false;--> statement-breakpoint
DO $$
DECLARE t RECORD; new_id uuid;
BEGIN
  FOR t IN SELECT id, organization_id, device_name, created_by FROM pos_tokens WHERE caja_id IS NULL LOOP
    INSERT INTO cajas (organization_id, name, type, created_by)
      VALUES (t.organization_id, t.device_name, 'register', t.created_by)
      RETURNING id INTO new_id;
    UPDATE pos_tokens SET caja_id = new_id WHERE id = t.id;
  END LOOP;
END $$;
