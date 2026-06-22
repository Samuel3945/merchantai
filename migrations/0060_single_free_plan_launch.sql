-- Launch config: collapse the customer-facing catalog to a single free plan.
--
-- The plan catalog (migration 0023) is operator-managed data, not code, so this
-- is a data migration rather than a code change. We hide the paid tiers from
-- tenants by flipping `is_public` to false; the rows are NOT archived or
-- deleted, so:
--   * listPublicPlans() (is_public = true) stops returning them — the pricing
--     page shows only "Gratis".
--   * upgradePlan() refuses them (it requires is_public AND not archived) — no
--     tenant can land on a hidden paid plan.
--   * the operator Pricing Studio (/platform/plans) still lists them with no
--     is_public filter, so paid tiers return later with a single toggle — no
--     revert migration needed.
--
-- We also rewrite the free plan's bullets to drop the delivery ("domicilios")
-- and AI mentions for launch, and surface the photo catalog import (the
-- onboarding wow). Plain UPDATEs are idempotent on re-run.
--
-- prod: node scripts/db-migrate.mjs
UPDATE "plans" SET "is_public" = false WHERE "slug" IN ('pro', 'business');--> statement-breakpoint
UPDATE "plans"
SET
  "is_public" = true,
  "feature_bullets" = '["Acceso completo: POS, inventario, ventas y caja", "Fiado y empleados incluidos", "Carga tu catálogo con una foto de tu lista de precios", "Todas las modalidades de venta (peso, mayoreo, perecederos)", "Reportes en PDF"]'::jsonb
WHERE "slug" = 'free';
