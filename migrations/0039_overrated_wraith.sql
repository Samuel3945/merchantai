CREATE TYPE "public"."transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch');--> statement-breakpoint
CREATE TYPE "public"."transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability');--> statement-breakpoint
CREATE TABLE "transfer_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sale_payment_id" uuid,
	"pos_token_id" uuid,
	"cash_session_id" uuid,
	"method" text NOT NULL,
	"expected_amount" numeric(12, 2) NOT NULL,
	"arrived_amount" numeric(12, 2),
	"reference" text,
	"status" "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
	"reconciled_by" text,
	"reconciled_at" timestamp,
	"note" text,
	"resolution_type" "transfer_resolution_type",
	"resolved_by" text,
	"resolved_at" timestamp,
	"resolution_fiado_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fiado_movements" ADD COLUMN "transfer_reconciliation_id" uuid;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_sale_payment_id_sale_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_pos_token_id_pos_tokens_id_fk" FOREIGN KEY ("pos_token_id") REFERENCES "public"."pos_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_cash_session_id_cash_sessions_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_resolution_fiado_id_fiados_id_fk" FOREIGN KEY ("resolution_fiado_id") REFERENCES "public"."fiados"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_reconciliations_sale_payment_idx" ON "transfer_reconciliations" USING btree ("sale_payment_id") WHERE "transfer_reconciliations"."sale_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transfer_reconciliations_org_status_idx" ON "transfer_reconciliations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "transfer_reconciliations_session_idx" ON "transfer_reconciliations" USING btree ("cash_session_id");--> statement-breakpoint
ALTER TABLE "fiado_movements" ADD CONSTRAINT "fiado_movements_transfer_reconciliation_id_transfer_reconciliations_id_fk" FOREIGN KEY ("transfer_reconciliation_id") REFERENCES "public"."transfer_reconciliations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: one reconciliation row per existing transfer-like sale payment.
-- Idempotent via the UNIQUE(sale_payment_id) index (ON CONFLICT DO NOTHING), so
-- it is safe even after the going-forward write path has inserted some rows.
-- cash_session_id is matched by device + time window; NULL when no session
-- contained the payment (admin / legacy money-in). Cash, card/datáfono and the
-- fiado credit portion are excluded — they are not transfers to reconcile.
INSERT INTO "transfer_reconciliations"
	("organization_id", "sale_payment_id", "pos_token_id", "cash_session_id", "method", "expected_amount", "reference", "created_at")
SELECT
	s."organization_id",
	sp."id",
	s."pos_token_id",
	cs."id",
	sp."method",
	sp."amount",
	sp."reference",
	sp."created_at"
FROM "sale_payments" sp
JOIN "sales" s ON s."id" = sp."sale_id"
LEFT JOIN LATERAL (
	SELECT cs2."id"
	FROM "cash_sessions" cs2
	WHERE cs2."organization_id" = s."organization_id"
		AND cs2."pos_token_id" IS NOT DISTINCT FROM s."pos_token_id"
		AND sp."created_at" >= cs2."opened_at"
		AND sp."created_at" <= COALESCE(cs2."closed_at", now())
	ORDER BY cs2."opened_at" DESC
	LIMIT 1
) cs ON true
WHERE lower(btrim(sp."method")) NOT LIKE '%efectivo%'
	AND lower(btrim(sp."method")) NOT LIKE '%cash%'
	AND lower(btrim(sp."method")) NOT LIKE '%tarjeta%'
	AND lower(btrim(sp."method")) NOT LIKE '%datafono%'
	AND lower(btrim(sp."method")) NOT LIKE '%datáfono%'
	AND lower(btrim(sp."method")) NOT LIKE '%card%'
	AND lower(btrim(sp."method")) NOT LIKE '%fiado%'
ON CONFLICT DO NOTHING;