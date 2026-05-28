import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/libs/DB';
import { expirationSuggestionsSchema } from '@/models/Schema';

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
  const now = new Date();

  const updated = await db
    .update(expirationSuggestionsSchema)
    .set({
      status: 'rejected',
      resolvedAt: now,
      resolvedBy: userId,
    })
    .where(
      and(
        eq(expirationSuggestionsSchema.id, id),
        eq(expirationSuggestionsSchema.organizationId, orgId),
        eq(expirationSuggestionsSchema.status, 'pending'),
      ),
    )
    .returning({ id: expirationSuggestionsSchema.id });

  if (updated.length === 0) {
    return NextResponse.json(
      { error: 'not_found_or_not_pending' },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
