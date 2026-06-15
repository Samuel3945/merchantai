CREATE TABLE "treasury_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"amount" numeric(12, 2) NOT NULL,
	"type" "treasury_movement_type" NOT NULL,
	"category" text,
	"reason" text,
	"expense_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_from_account_id_treasury_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_to_account_id_treasury_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_movements_org_idx" ON "treasury_movements" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "treasury_movements_from_idx" ON "treasury_movements" USING btree ("from_account_id");--> statement-breakpoint
CREATE INDEX "treasury_movements_to_idx" ON "treasury_movements" USING btree ("to_account_id");--> statement-breakpoint
-- Hand-written: drizzle-kit does not emit raw CHECK constraints.
-- Invariant: both NULLs are forbidden (neither from nor to may be omitted
-- simultaneously). If both are set (transfer/consignacion) → num_nonnulls = 2 ✓.
-- If exactly one is set (entrada/salida/gasto/consignacion external) → num_nonnulls = 1 ✓.
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_mov_one_external" CHECK (
  num_nonnulls(from_account_id, to_account_id) = 2
  OR (
    num_nonnulls(from_account_id, to_account_id) = 1
    AND type IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment')
  )
);--> statement-breakpoint
-- Backfill: migrate existing treasury_transfers rows into treasury_movements.
-- Maps text account keys → resolved treasury_accounts UUIDs.
-- type='consignacion': 'caja_fuerte' → vault account; 'banco:<m>' → banco account
--   matched by payment_methods.name = <m>.
-- Run off-hours: residual drift (new transfers between snapshot and run) can be
-- resolved via a manual adjustment movement after cutover.
-- treasury_movement_type enum already exists (created in 0044).
INSERT INTO treasury_movements (
  organization_id,
  from_account_id,
  to_account_id,
  amount,
  type,
  reason,
  created_by,
  created_at
)
SELECT
  tt.organization_id,
  -- Resolve 'caja_fuerte' → the seeded caja_fuerte account for this org.
  -- Other from_account values are not expected at this point (only caja_fuerte
  -- used treasury_transfers in Phase 1). Falls back to NULL if unmatched.
  (
    SELECT ta.id
    FROM treasury_accounts ta
    WHERE ta.organization_id = tt.organization_id
      AND ta.type = 'caja_fuerte'
    LIMIT 1
  ) AS from_account_id,
  -- Resolve 'banco:<method>' → banco account whose payment_method.name matches.
  (
    SELECT ta.id
    FROM treasury_accounts ta
    JOIN payment_methods pm ON pm.id = ta.payment_method_id
    WHERE ta.organization_id = tt.organization_id
      AND ta.type = 'banco'
      AND pm.name = SUBSTRING(tt.to_account FROM 7) -- strip 'banco:' prefix
    LIMIT 1
  ) AS to_account_id,
  tt.amount,
  'consignacion'::treasury_movement_type AS type,
  tt.note AS reason,
  tt.created_by,
  tt.created_at
FROM treasury_transfers tt
-- Only migrate rows that originated from caja_fuerte (the only Phase-1 usage).
-- Rows with unresolvable from/to are intentionally excluded to avoid CHECK
-- violations (they can be re-created as manual adjustment movements post-cutover).
WHERE tt.from_account = 'caja_fuerte'
  AND tt.to_account LIKE 'banco:%'
  AND EXISTS (
    SELECT 1 FROM treasury_accounts ta
    WHERE ta.organization_id = tt.organization_id AND ta.type = 'caja_fuerte'
  )
  AND EXISTS (
    SELECT 1
    FROM treasury_accounts ta
    JOIN payment_methods pm ON pm.id = ta.payment_method_id
    WHERE ta.organization_id = tt.organization_id
      AND ta.type = 'banco'
      AND pm.name = SUBSTRING(tt.to_account FROM 7)
  )
  -- Idempotency guard. The PK is a random UUID, so ON CONFLICT can never fire —
  -- it would NOT make this backfill safe to re-run. Instead we skip any transfer
  -- already migrated, matched on its natural key (org + type + amount + the
  -- created_at copied verbatim from the source transfer). This makes a second
  -- run a genuine no-op instead of double-counting bank balances.
  AND NOT EXISTS (
    SELECT 1 FROM treasury_movements tm
    WHERE tm.organization_id = tt.organization_id
      AND tm.type = 'consignacion'
      AND tm.amount = tt.amount
      AND tm.created_at = tt.created_at
  );