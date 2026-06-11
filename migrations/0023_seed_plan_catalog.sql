-- Seed the plan catalog with the exact values that were hardcoded in
-- actions/plans.ts (AI credits), actions/pos-tokens.ts (device slots),
-- actions/employees.ts (cashier slots) and features/plans/PlansClient.tsx
-- (prices, descriptions, bullets), so behavior is unchanged after the
-- entitlements resolver replaces those maps. Idempotent: re-running is a no-op.
INSERT INTO "plans" ("slug", "name", "description", "price_monthly_cop", "feature_bullets", "is_public", "is_default", "sort_order")
VALUES
  (
    'free',
    'Gratis',
    'Acceso completo al software, sin compromiso.',
    0,
    '["Acceso completo: POS, inventario, ventas y caja", "Fiado, domicilios y empleados incluidos", "Todas las modalidades de venta (peso, mayoreo, perecederos)", "Reportes en PDF", "Sin agentes de IA incluidos"]'::jsonb,
    true,
    true,
    0
  ),
  (
    'pro',
    'Pro',
    'Todo el software, más IA que potencia tus ventas.',
    89000,
    '["Todo lo del plan Gratis", "Sales Manager IA: 500 consultas/mes", "Reportes avanzados"]'::jsonb,
    true,
    false,
    1
  ),
  (
    'business',
    'Business',
    'Más IA y atención al cliente automatizada.',
    199000,
    '["Todo lo del plan Pro", "Customer Service IA: 1.000 consultas/mes", "Soporte prioritario"]'::jsonb,
    true,
    false,
    2
  )
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "plan_entitlements" ("plan_id", "key", "value")
SELECT p."id", e."key", e."value"
FROM "plans" p
JOIN (
  VALUES
    ('free', 'max_cashiers', 1),
    ('free', 'max_pos_devices', 1),
    ('free', 'ai_credits_sales_manager', 0),
    ('free', 'ai_credits_customer_service', 0),
    ('free', 'feature_smart_stock', 0),
    ('pro', 'max_cashiers', 5),
    ('pro', 'max_pos_devices', 5),
    ('pro', 'ai_credits_sales_manager', 500),
    ('pro', 'ai_credits_customer_service', 0),
    ('pro', 'feature_smart_stock', 1),
    ('business', 'max_cashiers', 10),
    ('business', 'max_pos_devices', 10),
    ('business', 'ai_credits_sales_manager', 500),
    ('business', 'ai_credits_customer_service', 1000),
    ('business', 'feature_smart_stock', 1)
) AS e("slug", "key", "value") ON e."slug" = p."slug"
ON CONFLICT ("plan_id", "key") DO NOTHING;
