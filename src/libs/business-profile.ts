// Per-org business-intelligence snapshot — PLATFORM analytics, never shown to
// the shop. Deterministic (no LLM, same philosophy as smart-stock): every value
// is recomputed wholesale from the source tables, so the snapshot can never
// drift. Populates business_profile so we can later analyze what kinds of
// businesses use the software, how big, and how they sell.

import { sql } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { logger } from '@/libs/Logger';
import { businessProfileSchema } from '@/models/Schema';

const STALE_HOURS = 24;

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const toNumericString = (v: unknown): string | null =>
  v == null ? null : String(v);

// Coarse v1 classification from objective ratios. Intentionally simple and
// honest — refinable later from the stored raw signals. Exported for tests.
export function inferBusinessType(s: {
  productCount: number;
  perishableCount: number;
  wholesaleCount: number;
}): 'grocery_fresh' | 'wholesale' | 'retail_general' | null {
  if (s.productCount === 0) {
    return null;
  }
  if (s.perishableCount / s.productCount >= 0.5) {
    return 'grocery_fresh';
  }
  if (s.wholesaleCount / s.productCount >= 0.5) {
    return 'wholesale';
  }
  return 'retail_general';
}

// Recomputes and upserts the org's snapshot. Throws on DB error — callers that
// must not break the request use recomputeBusinessProfileIfStale instead.
export async function recomputeBusinessProfile(orgId: string): Promise<void> {
  const catalogRes = await db.execute(sql`
    SELECT
      count(*)::int AS product_count,
      count(*) FILTER (WHERE status = 'published')::int AS active_product_count,
      count(*) FILTER (WHERE is_perishable)::int AS perishable_count,
      count(*) FILTER (WHERE is_wholesale)::int AS wholesale_count,
      count(DISTINCT category_id)::int AS distinct_categories,
      COALESCE(sum(stock), 0)::int AS total_stock_units,
      ROUND(AVG(price), 2) AS avg_price,
      MIN(price) AS min_price,
      MAX(price) AS max_price
    FROM products
    WHERE organization_id = ${orgId} AND deleted = false
  `);

  // 30-day commerce window. Only finalized sales count toward velocity.
  const commerceRes = await db.execute(sql`
    SELECT
      COALESCE(sum(si.qty), 0)::int AS units_sold_30d,
      count(DISTINCT s.id)::int AS sales_count_30d,
      count(DISTINCT si.product_id)::int AS distinct_products_sold_30d
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.organization_id = ${orgId}
      AND s.created_at >= now() - interval '30 days'
      AND s.status IN ('completed', 'settled')
  `);

  // Restock frequency: entry movements in the window.
  const purchasesRes = await db.execute(sql`
    SELECT count(*)::int AS purchase_events_30d
    FROM stock_movements
    WHERE organization_id = ${orgId}
      AND type = 'entry'
      AND created_at >= now() - interval '30 days'
  `);

  const topCatsRes = await db.execute(sql`
    SELECT name, usage_count
    FROM categories
    WHERE organization_id = ${orgId} AND usage_count > 0
    ORDER BY usage_count DESC, name
    LIMIT 5
  `);

  const catalog = (catalogRes.rows?.[0] ?? {}) as Record<string, unknown>;
  const commerce = (commerceRes.rows?.[0] ?? {}) as Record<string, unknown>;
  const purchases = (purchasesRes.rows?.[0] ?? {}) as Record<string, unknown>;
  const topCategories = (topCatsRes.rows ?? []).map(r => ({
    name: String((r as Record<string, unknown>).name ?? ''),
    usageCount: toInt((r as Record<string, unknown>).usage_count),
  }));

  const productCount = toInt(catalog.product_count);
  const perishableCount = toInt(catalog.perishable_count);
  const wholesaleCount = toInt(catalog.wholesale_count);

  const snapshot = {
    productCount,
    activeProductCount: toInt(catalog.active_product_count),
    perishableCount,
    wholesaleCount,
    distinctCategories: toInt(catalog.distinct_categories),
    totalStockUnits: toInt(catalog.total_stock_units),
    avgPrice: toNumericString(catalog.avg_price),
    minPrice: toNumericString(catalog.min_price),
    maxPrice: toNumericString(catalog.max_price),
    unitsSold30d: toInt(commerce.units_sold_30d),
    salesCount30d: toInt(commerce.sales_count_30d),
    distinctProductsSold30d: toInt(commerce.distinct_products_sold_30d),
    purchaseEvents30d: toInt(purchases.purchase_events_30d),
    topCategories,
    inferredBusinessType: inferBusinessType({
      productCount,
      perishableCount,
      wholesaleCount,
    }),
    computedAt: new Date(),
  };

  await db
    .insert(businessProfileSchema)
    .values({ organizationId: orgId, ...snapshot })
    .onConflictDoUpdate({
      target: businessProfileSchema.organizationId,
      set: snapshot,
    });
}

// Fire-from-a-page-load wrapper: recomputes only when the snapshot is missing or
// older than STALE_HOURS, and NEVER throws — a failed analytics refresh must not
// break the shop. Idempotent, so concurrent callers just redo cheap work.
export async function recomputeBusinessProfileIfStale(
  orgId: string,
): Promise<void> {
  try {
    const res = await db.execute(sql`
      SELECT computed_at FROM business_profile
      WHERE organization_id = ${orgId}
        AND computed_at >= now() - make_interval(hours => ${STALE_HOURS})
      LIMIT 1
    `);
    if ((res.rows?.length ?? 0) > 0) {
      return; // still fresh
    }
    await recomputeBusinessProfile(orgId);
  } catch (err) {
    logger.error('business_profile_refresh_failed', {
      organizationId: orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
