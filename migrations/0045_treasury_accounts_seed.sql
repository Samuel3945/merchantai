-- Migration 0045: Opening-balance seed for treasury_accounts
-- Data migration only — no DDL changes.
--
-- Seeds one treasury_accounts row per container using values derived from the
-- existing Phase-1 getTreasuryPosition derivation so that the ledger balance
-- starts at the correct historical value.
--
-- Safety note: run off-hours.  Any residual drift between the derivation and the
-- physical count should be corrected via an adjustment treasury_movements row
-- after seeding — do NOT re-run this migration.
--
-- Post-run assertion (run manually to verify):
--   SELECT type, name, opening_balance FROM treasury_accounts ORDER BY type, name;
-- Expected: one caja_fuerte row with opening_balance = SUM(withdrawals) - SUM(consignaciones),
--           one banco row per method that has confirmed/mismatch reconciliations.

-- ── Caja Fuerte ───────────────────────────────────────────────────────────────
-- Opening balance = total security withdrawals − total consignaciones out.
-- One synthetic vault per organization that has any cash movements.
INSERT INTO treasury_accounts (
  id,
  organization_id,
  type,
  name,
  opening_balance,
  active,
  payment_method_id,
  pos_token_id,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  sub.organization_id,
  'caja_fuerte',
  'Caja fuerte',
  -- No floor: must mirror getTreasuryPosition/seedOpeningBalance exactly
  -- (withdrawn - consignado), which can be negative. Clamping here would make
  -- the 2C cutover jump the balance and break the no-op seed invariant.
  COALESCE(sub.total_withdrawn, 0) - COALESCE(sub.total_consignado, 0),
  true,
  NULL,
  NULL,
  now(),
  now()
FROM (
  SELECT
    cm.organization_id,
    SUM(cm.amount) AS total_withdrawn,
    (
      SELECT COALESCE(SUM(tt.amount), 0)
      FROM treasury_transfers tt
      WHERE tt.organization_id = cm.organization_id
        AND tt.from_account = 'caja_fuerte'
    ) AS total_consignado
  FROM cash_movements cm
  WHERE cm.type = 'withdrawal'
  GROUP BY cm.organization_id
) sub
ON CONFLICT (organization_id, name) DO NOTHING;
--> statement-breakpoint

-- ── Banco accounts ────────────────────────────────────────────────────────────
-- One row per (org, bank method) that has confirmed or mismatch reconciliations,
-- PLUS any consignaciones received via treasury_transfers.
-- opening_balance = SUM(arrived_amount OR expected_amount for confirmed/mismatch)
--                 + SUM(treasury_transfers landing on banco:<method>)
-- payment_method_id resolved by name match; left NULL when unmatched (owner
-- relinks via UI — acceptable per design §1 open questions).
INSERT INTO treasury_accounts (
  id,
  organization_id,
  type,
  name,
  opening_balance,
  active,
  payment_method_id,
  pos_token_id,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  combined.organization_id,
  'banco',
  combined.method,
  SUM(COALESCE(combined.reconciled_balance, 0)) + SUM(COALESCE(combined.consignado_balance, 0)),
  true,
  (
    SELECT pm.id
    FROM payment_methods pm
    WHERE pm.organization_id = combined.organization_id
      AND pm.name = combined.method
    LIMIT 1
  ),
  NULL,
  now(),
  now()
FROM (
  -- Confirmed/mismatch reconciliations
  SELECT
    organization_id,
    method,
    SUM(COALESCE(arrived_amount, expected_amount)) AS reconciled_balance,
    0::numeric                                    AS consignado_balance
  FROM transfer_reconciliations
  WHERE status IN ('confirmed', 'mismatch')
  GROUP BY organization_id, method

  UNION ALL

  -- Treasury transfers that landed on a banco account (format: 'banco:<method>')
  SELECT
    organization_id,
    SUBSTRING(to_account FROM 7) AS method, -- strip 'banco:' prefix
    0::numeric                              AS reconciled_balance,
    SUM(amount)                             AS consignado_balance
  FROM treasury_transfers
  WHERE to_account LIKE 'banco:%'
  GROUP BY organization_id, to_account
) combined
GROUP BY combined.organization_id, combined.method
ON CONFLICT (organization_id, name) DO NOTHING;
