import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import {
  computeExpectedAmount,
  findOpenSession,
  toMoney,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { resolvePosAuth } from '@/libs/pos-auth';
import { cashSessionsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CloseBody = {
  countedAmount?: number | string;
  notes?: string | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const ctx = await resolvePosAuth(
    req.headers.get('authorization'),
    req.headers.get('x-pos-cashier-id'),
  );
  if (!ctx) {
    return NextResponse.json(
      { error: 'Sesión inválida o expirada' },
      { status: 401 },
    );
  }

  let body: CloseBody;
  try {
    body = (await req.json()) as CloseBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (body.countedAmount === undefined || body.countedAmount === null) {
    return NextResponse.json(
      { error: 'countedAmount es requerido' },
      { status: 400 },
    );
  }

  const counted = toMoney(body.countedAmount);

  try {
    const session = await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId);
      if (!open) {
        throw new Error('No hay caja abierta para cerrar.');
      }

      const expected = await computeExpectedAmount(tx, open);
      const difference = Number.parseFloat(
        (Number.parseFloat(counted) - expected).toFixed(2),
      );

      const mergedNotes = body.notes
        ? open.notes
          ? `${open.notes}; cierre: ${body.notes}`
          : `cierre: ${body.notes}`
        : open.notes;

      const [closed] = await tx
        .update(cashSessionsSchema)
        .set({
          status: 'closed',
          closedAt: new Date(),
          closedBy: ctx.cashierName || 'Cajero',
          countedAmount: counted,
          expectedAmount: toMoney(expected),
          difference: toMoney(difference),
          notes: mergedNotes,
        })
        .where(eq(cashSessionsSchema.id, open.id))
        .returning();

      if (!closed) {
        throw new Error('No se pudo cerrar la caja');
      }
      return closed;
    });

    await logAction({
      organizationId: ctx.organizationId,
      actor: resolvePosActor(ctx),
      action: 'cash.closed',
      entityType: 'cash_session',
      entityId: session.id,
      after: {
        id: session.id,
        closedBy: session.closedBy,
        countedAmount: session.countedAmount,
        expectedAmount: session.expectedAmount,
        difference: session.difference,
        notes: session.notes,
      },
      metadata: { cashierName: ctx.cashierName, source: ctx.source },
      ip:
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null,
      userAgent: req.headers.get('user-agent'),
    });

    return NextResponse.json(session);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al cerrar caja' },
      { status: 400 },
    );
  }
}
