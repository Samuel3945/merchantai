import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  computeExpectedAmount,
  findOpenSession,
  getOpeningExpected,
  toPosCashSession,
} from '@/libs/cash-helpers';
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

  const session = await findOpenSession(db, ctx.organizationId, ctx.tokenId);
  if (!session) {
    // Include expected_opening so the device can pre-fill "Deberías abrir con $X"
    // before PR #2 (device open screen) ships (R1 scenario 3).
    const expectedOpening = ctx.tokenId
      ? (await getOpeningExpected(db, ctx.organizationId, ctx.tokenId)).expected
      : 0;
    return NextResponse.json({ session: null, movements: [], expected: 0, expected_opening: expectedOpening });
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

  return NextResponse.json({ session: toPosCashSession(session), movements, expected });
}
