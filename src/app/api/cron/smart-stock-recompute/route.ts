import type { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { runCron } from '@/libs/cron-runner';
import { db } from '@/libs/DB';
import { productsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// PORT PENDING: the smart-stock engine lives at app/src/lib/smart-stock-engine.ts
// and writes to `smart_stock_cache`. Neither the engine nor the cache table have
// been migrated to MerchantAI/app yet. The cron iterates orgs × active products
// as the prompt specifies; the per-product recompute is a no-op until the
// engine is ported. The loop shape and counters stay stable so swapping the
// body for the real recompute is a single-function change.
async function recomputeProductCache(
  _organizationId: string,
  _productId: string,
): Promise<void> {
  // TODO: replace with smart-stock-engine.recomputeOne(orgId, productId).
}

export async function GET(req: Request): Promise<NextResponse> {
  return runCron('smart-stock-recompute', req, async () => {
    const orgRows = await db
      .selectDistinct({ organizationId: productsSchema.organizationId })
      .from(productsSchema)
      .where(eq(productsSchema.deleted, false));

    let recomputed = 0;
    const orgErrors: string[] = [];

    for (const { organizationId } of orgRows) {
      try {
        const products = await db
          .select({ id: productsSchema.id })
          .from(productsSchema)
          .where(
            and(
              eq(productsSchema.organizationId, organizationId),
              eq(productsSchema.deleted, false),
              eq(productsSchema.status, 'published'),
            ),
          );

        for (const p of products) {
          await recomputeProductCache(organizationId, p.id);
          recomputed += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        orgErrors.push(`${organizationId}: ${message}`);
      }
    }

    return {
      processed: recomputed,
      orgs: orgRows.length,
      recomputed,
      orgErrors,
    };
  });
}
