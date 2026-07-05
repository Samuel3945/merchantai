-- Caja <-> Domiciliario: modo de caja + ledger del bolsillo del domiciliario.
--
-- pos_cash_mode: marca si el CAJON de una caja es compartido (varias manos,
--   responsabilidad colectiva) o dividido (un solo responsable = un culpable
--   claro si descuadra). Default 'divided': cada caja independiente salvo que el
--   dueno la marque compartida.
--
-- courier_cash_movements: ledger APPEND-ONLY del efectivo que el domiciliario
--   lleva encima. El saldo del domiciliario NUNCA se guarda como valor absoluto:
--   se DERIVA de este ledger (misma filosofia que el FIFO de stock). Direcciones:
--     base_from_caja    la caja le presta base para dar vuelto (cajon -$, domi +$)
--     sale_collected    venta a domicilio en efectivo cobrada (domi +$, NO al cajon)
--     handover_to_caja  el domiciliario entrega billetes a la caja (domi -$, cajon +$)
--   client_movement_id: UUID generado en el dispositivo => idempotente offline
--   (mismo patron que sale_idempotency_key). Todo es no-destructivo.
CREATE TYPE "pos_cash_mode" AS ENUM('shared', 'divided');--> statement-breakpoint
CREATE TYPE "courier_cash_direction" AS ENUM('base_from_caja', 'sale_collected', 'handover_to_caja');--> statement-breakpoint
ALTER TABLE "pos_tokens" ADD COLUMN "cash_mode" "pos_cash_mode" DEFAULT 'divided' NOT NULL;--> statement-breakpoint
CREATE TABLE "courier_cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"shift_id" uuid,
	"courier_id" uuid NOT NULL,
	"pos_token_id" uuid,
	"direction" "courier_cash_direction" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"sale_id" uuid,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"client_movement_id" uuid
);--> statement-breakpoint
ALTER TABLE "courier_cash_movements" ADD CONSTRAINT "courier_cash_movements_shift_id_courier_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."courier_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_cash_movements" ADD CONSTRAINT "courier_cash_movements_courier_id_pos_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."pos_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_cash_movements" ADD CONSTRAINT "courier_cash_movements_pos_token_id_pos_tokens_id_fk" FOREIGN KEY ("pos_token_id") REFERENCES "public"."pos_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_cash_movements" ADD CONSTRAINT "courier_cash_movements_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_cash_movements_org_client_idx" ON "courier_cash_movements" USING btree ("organization_id","client_movement_id") WHERE "courier_cash_movements"."client_movement_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "courier_cash_movements_org_courier_idx" ON "courier_cash_movements" USING btree ("organization_id","courier_id");--> statement-breakpoint
CREATE INDEX "courier_cash_movements_org_shift_idx" ON "courier_cash_movements" USING btree ("organization_id","shift_id");
