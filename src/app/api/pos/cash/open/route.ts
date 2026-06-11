import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { cashSessionsSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type OpenBody = {
  openingAmount?: number | string;
  notes?: string | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: OpenBody;
  try {
    body = (await req.json()) as OpenBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const opening = toMoney(body.openingAmount ?? 0);
  if (Number.parseFloat(opening) < 0) {
    return NextResponse.json(
      { error: 'openingAmount debe ser >= 0' },
      { status: 400 },
    );
  }

  try {
    const session = await db.transaction(async (tx) => {
      const existing = await findOpenSession(tx, ctx.organizationId);
      if (existing) {
        throw new Error('Ya hay una caja abierta. Ciérrala primero.');
      }

      const [created] = await tx
        .insert(cashSessionsSchema)
        .values({
          organizationId: ctx.organizationId,
          openingAmount: opening,
          openedBy: ctx.cashierName || 'Cajero',
          status: 'open',
          notes: body.notes ?? null,
        })
        .returning();

      if (!created) {
        throw new Error('No se pudo abrir la caja');
      }
      return created;
    });

    await logAction({
      organizationId: ctx.organizationId,
      actor: resolvePosActor(ctx),
      action: 'cash.opened',
      entityType: 'cash_session',
      entityId: session.id,
      after: {
        id: session.id,
        openingAmount: session.openingAmount,
        openedBy: session.openedBy,
        notes: session.notes,
      },
      metadata: { cashierName: ctx.cashierName, source: ctx.source },
      ip:
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null,
      userAgent: req.headers.get('user-agent'),
    });

    return NextResponse.json(session, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al abrir caja' },
      { status: 400 },
    );
  }
}
