import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import {
  expirationSuggestionsSchema,
  productsSchema,
} from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  const { userId, orgId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!orgId) {
    return NextResponse.json({ error: 'no_active_org' }, { status: 400 });
  }

  const { id } = await ctx.params;

  const result = await db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(expirationSuggestionsSchema)
      .where(
        and(
          eq(expirationSuggestionsSchema.id, id),
          eq(expirationSuggestionsSchema.organizationId, orgId),
        ),
      )
      .for('update')
      .limit(1);

    if (!suggestion) {
      return { status: 404 as const, body: { error: 'not_found' } };
    }

    if (suggestion.status !== 'pending') {
      return {
        status: 409 as const,
        body: { error: 'not_pending', currentStatus: suggestion.status },
      };
    }

    const now = new Date();

    await tx
      .update(productsSchema)
      .set({ price: suggestion.suggestedPrice })
      .where(
        and(
          eq(productsSchema.id, suggestion.productId),
          eq(productsSchema.organizationId, orgId),
        ),
      );

    await tx
      .update(expirationSuggestionsSchema)
      .set({
        status: 'accepted',
        resolvedAt: now,
        resolvedBy: userId,
      })
      .where(eq(expirationSuggestionsSchema.id, id));

    return {
      status: 200 as const,
      body: {
        ok: true,
        productId: suggestion.productId,
        appliedPrice: suggestion.suggestedPrice,
      },
    };
  });

  return NextResponse.json(result.body, { status: result.status });
}
