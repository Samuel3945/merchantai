// Shared category DB helpers — NOT a 'use server' module on purpose, so the
// product actions AND the re-categorization engine can reuse the exact same
// upsert/refresh logic without exposing these internals as server actions.

import type { db } from '@/libs/DB';
import { and, eq, sql } from 'drizzle-orm';
import { categoriesSchema } from '@/models/Schema';

// Drizzle transaction handle — same derivation as libs/sale-number.ts.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Ensures the org has a category row for `name` (created on demand — this is what
// makes categories dynamic) and returns its id. Idempotent via the
// (organization_id, slug) unique index; the slug normalizes case/whitespace so
// "Bebidas" and " bebidas " collapse to one. Never touches usageCount: that is
// recomputed from products by refreshCategory so it can't drift. On conflict the
// existing row's source/name are kept (first writer wins).
export async function upsertCategory(
  tx: Tx,
  orgId: string,
  name: string,
  source: 'manual' | 'ai' | 'auto' = 'manual',
): Promise<string> {
  const trimmed = name.trim();
  const slug = trimmed.toLowerCase();
  const [cat] = await tx
    .insert(categoriesSchema)
    .values({ organizationId: orgId, name: trimmed, slug, source })
    .onConflictDoUpdate({
      target: [categoriesSchema.organizationId, categoriesSchema.slug],
      // No-op touch so the existing row is RETURNed on conflict (DO NOTHING
      // would return nothing).
      set: { updatedAt: new Date() },
    })
    .returning({ id: categoriesSchema.id });
  if (!cat) {
    throw new Error('Failed to upsert category');
  }
  return cat.id;
}

// Recomputes a category's learned stats from the products table — the single
// source of truth, so neither value can drift (same rule as products.stock vs
// the FIFO ledger). Call after any change that re-points a product's category_id
// or edits its attributes:
//   - usageCount: live count of non-deleted products in the category.
//   - attributeTemplate: the most frequent attribute KEYS across those products
//     (top 12, by frequency) — this is what makes "characterization that varies
//     with the products that come in" dynamic.
export async function refreshCategory(
  tx: Tx,
  orgId: string,
  categoryId: string | null,
): Promise<void> {
  if (!categoryId) {
    return;
  }
  await tx
    .update(categoriesSchema)
    .set({
      usageCount: sql`(
        SELECT count(*)::int FROM products
        WHERE products.category_id = ${categoryId} AND products.deleted = false
      )`,
      attributeTemplate: sql`COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('key', t.key, 'count', t.count)
          ORDER BY t.count DESC, t.key
        )
        FROM (
          SELECT k AS key, count(*)::int AS count
          FROM products p
          CROSS JOIN LATERAL jsonb_object_keys(p.attributes) AS k
          WHERE p.category_id = ${categoryId}
            AND p.deleted = false
            AND jsonb_typeof(p.attributes) = 'object'
          GROUP BY k
          ORDER BY count(*) DESC, k
          LIMIT 12
        ) t
      ), '[]'::jsonb)`,
    })
    .where(
      and(
        eq(categoriesSchema.id, categoryId),
        eq(categoriesSchema.organizationId, orgId),
      ),
    );
}
