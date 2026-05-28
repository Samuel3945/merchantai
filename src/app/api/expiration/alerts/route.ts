import { auth } from '@clerk/nextjs/server';
import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import {
  expirationRiskCacheSchema,
  expirationSuggestionsSchema,
  productsSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const { userId, orgId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!orgId) {
    return NextResponse.json({ error: 'no_active_org' }, { status: 400 });
  }

  const url = new URL(req.url);
  const tierFilter = url.searchParams.get('tier');

  const conditions = [eq(expirationRiskCacheSchema.organizationId, orgId)];

  const rows = await db
    .select({
      movementId: expirationRiskCacheSchema.movementId,
      productId: expirationRiskCacheSchema.productId,
      payload: expirationRiskCacheSchema.payload,
      computedAt: expirationRiskCacheSchema.computedAt,
      productName: productsSchema.name,
      productPrice: productsSchema.price,
      productStock: productsSchema.stock,
    })
    .from(expirationRiskCacheSchema)
    .innerJoin(
      productsSchema,
      eq(productsSchema.id, expirationRiskCacheSchema.productId),
    )
    .where(and(...conditions))
    .orderBy(desc(expirationRiskCacheSchema.computedAt));

  const filtered
    = tierFilter && ['atencion', 'urgente', 'critico'].includes(tierFilter)
      ? rows.filter((r) => {
          const p = r.payload as { tier?: string } | null;
          return p?.tier === tierFilter;
        })
      : rows;

  const pendingSuggestions = await db
    .select({
      id: expirationSuggestionsSchema.id,
      movementId: expirationSuggestionsSchema.movementId,
      productId: expirationSuggestionsSchema.productId,
      tier: expirationSuggestionsSchema.tier,
      suggestedPct: expirationSuggestionsSchema.suggestedPct,
      maxSafePct: expirationSuggestionsSchema.maxSafePct,
      suggestedPrice: expirationSuggestionsSchema.suggestedPrice,
      basePrice: expirationSuggestionsSchema.basePrice,
      reasoning: expirationSuggestionsSchema.reasoning,
      createdAt: expirationSuggestionsSchema.createdAt,
      reopenCount: expirationSuggestionsSchema.reopenCount,
    })
    .from(expirationSuggestionsSchema)
    .where(
      and(
        eq(expirationSuggestionsSchema.organizationId, orgId),
        eq(expirationSuggestionsSchema.status, 'pending'),
      ),
    )
    .orderBy(desc(expirationSuggestionsSchema.createdAt));

  const suggestionByMovement = new Map(
    pendingSuggestions.map(s => [s.movementId, s]),
  );

  const alerts = filtered.map(row => ({
    movementId: row.movementId,
    productId: row.productId,
    productName: row.productName,
    productStock: row.productStock,
    risk: row.payload,
    suggestion: suggestionByMovement.get(row.movementId) ?? null,
    computedAt: row.computedAt,
  }));

  return NextResponse.json({ ok: true, alerts });
}
