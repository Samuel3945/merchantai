import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import {
  computeExpectedAmount,
  findOpenSession,
  toMoney,
  toPosCashSession,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { getOrCreatePendingAccount, getTreasuryHandoverEnabled, recordHandoverMovement } from '@/libs/treasury';
import { cashSessionsSchema, posTokensSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CloseBody = {
  countedAmount?: number | string;
  notes?: string | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
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

  // Build attribution label: "employee (device)" when both are known, otherwise just cashierName
  let attribution = ctx.cashierName || 'Cajero';
  if (ctx.source === 'token' && ctx.tokenId) {
    const [tokenRow] = await db
      .select({ deviceName: posTokensSchema.deviceName })
      .from(posTokensSchema)
      .where(eq(posTokensSchema.id, ctx.tokenId))
      .limit(1);
    if (tokenRow && ctx.cashierId) {
      attribution = `${ctx.cashierName} (${tokenRow.deviceName})`;
    } else if (tokenRow) {
      attribution = tokenRow.deviceName;
    }
  }

  try {
    const session = await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
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
          closedBy: attribution,
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

      // Phase 3 PR4: record handover movement ONLY when the org opted in.
      // Default OFF — carry-over (Option A) unchanged, no double-count.
      const handoverEnabled = await getTreasuryHandoverEnabled(tx, ctx.organizationId);
      if (handoverEnabled && Number.parseFloat(counted) > 0) {
        const pending = await getOrCreatePendingAccount(tx, ctx.organizationId, attribution);
        await recordHandoverMovement(tx, {
          organizationId: ctx.organizationId,
          toAccountId: pending.id,
          amount: counted,
          createdBy: attribution,
          cashSessionId: closed.id,
        });
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

    return NextResponse.json(toPosCashSession(session));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al cerrar caja' },
      { status: 400 },
    );
  }
}
