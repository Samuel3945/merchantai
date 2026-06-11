import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { computeExpectedAmount, findOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { cashMovementsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  const session = await findOpenSession(db, ctx.organizationId);
  if (!session) {
    return NextResponse.json({ session: null, movements: [], expected: 0 });
  }

  const [movements, expected] = await Promise.all([
    db
      .select()
      .from(cashMovementsSchema)
      .where(
        and(
          eq(cashMovementsSchema.sessionId, session.id),
          eq(cashMovementsSchema.organizationId, ctx.organizationId),
        ),
      )
      .orderBy(desc(cashMovementsSchema.createdAt)),
    computeExpectedAmount(db, session),
  ]);

  return NextResponse.json({ session, movements, expected });
}
