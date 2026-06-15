-- Migration 0047: Corrective opening_balance rebase for treasury_accounts
-- Context: migration 0045 seeded:
--   caja_fuerte: opening = W − C  (where W = total withdrawals, C = total consignaciones)
--   banco:       opening = R + C  (where R = reconciled transfers, C = consignaciones received)
-- Migration 0046 then backfilled those same consignaciones into treasury_movements as
-- type='consignacion' rows (from=vault, to=banco).
-- After the 2C cutover, balanceForAccount reads opening + Σ(to) − Σ(from), so:
--   vault post-cutover = (W−C) + 0 − C = W − 2C   ← double-counts the consignaciones
--   banco post-cutover = (R+C) + C − 0 = R + 2C   ← double-counts the consignaciones
-- Fix: rebase opening_balance to the NON-transfer base so that base + ledger = true value:
--   vault: opening += Σ(consignaciones from this vault)    → becomes W
--   banco: opening −= Σ(consignaciones into this banco)   → becomes R
-- After rebase:
--   balanceForAccount(vault) = W + 0 − C = W − C  ✓
--   balanceForAccount(banco) = R + C − 0 = R + C  ✓
--
-- Safety: run this in the same deployment as the getTreasuryPosition cutover (2C).
-- Re-run is idempotent only if no new consignaciones have been added to treasury_movements
-- between 0046 and this run — intended for the atomic 2C deployment.

-- Rebase caja_fuerte accounts: add back Σ(consignacion debits) so opening = W.
UPDATE treasury_accounts ta
SET opening_balance = ta.opening_balance + COALESCE(sub.total_consignado, 0)
FROM (
  SELECT
    tm.from_account_id AS account_id,
    SUM(tm.amount) AS total_consignado
  FROM treasury_movements tm
  WHERE tm.type = 'consignacion'
    AND tm.from_account_id IS NOT NULL
  GROUP BY tm.from_account_id
) sub
WHERE ta.id = sub.account_id
  AND ta.type = 'caja_fuerte';
--> statement-breakpoint

-- Rebase banco accounts: subtract Σ(consignacion credits) so opening = R.
UPDATE treasury_accounts ta
SET opening_balance = ta.opening_balance - COALESCE(sub.total_recibido, 0)
FROM (
  SELECT
    tm.to_account_id AS account_id,
    SUM(tm.amount) AS total_recibido
  FROM treasury_movements tm
  WHERE tm.type = 'consignacion'
    AND tm.to_account_id IS NOT NULL
  GROUP BY tm.to_account_id
) sub
WHERE ta.id = sub.account_id
  AND ta.type = 'banco';
