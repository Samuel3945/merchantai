-- Migration 0066: make supplier_payments.treasury_movement_id NOT NULL.
--
-- Context: In migration 0065, treasury_movement_id was created nullable while the
-- FK is ON DELETE RESTRICT. This was safe for Slice 1 (no supplier_payments rows
-- were inserted). Slice 2 introduces recordSupplierPaymentOutflow, which always
-- provides a valid treasury_movement_id. Enforcing NOT NULL here closes the gap:
-- a null value would bypass the FK constraint (PostgreSQL NULLs are not FK-checked)
-- and silently allow orphaned payment rows.
--
-- The supplier_payments table is empty in production (no rows were inserted before
-- Slice 2 ships), so this ALTER is safe and instant.
--
-- prod: node scripts/db-migrate.mjs

ALTER TABLE "supplier_payments"
  ALTER COLUMN "treasury_movement_id" SET NOT NULL;
