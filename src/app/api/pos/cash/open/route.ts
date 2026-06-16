import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import {
  findOpenSession,
  getOpeningExpected,
  toMoney,
  toPosCashSession,
  validateOpenCarryover,
} from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { requirePosAuth } from '@/libs/pos-auth';
import { cashSessionsSchema, posTokensSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type OpenBody = {
  openingAmount?: number | string;
  notes?: string | null;
  // Carry-over fields (optional — legacy device omits them; backward-compat preserved)
  explanation?: string | null;
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

  const counted = Number.parseFloat(toMoney(body.openingAmount ?? 0));
  if (counted < 0) {
    return NextResponse.json(
      { error: 'openingAmount debe ser >= 0' },
      { status: 400 },
    );
  }

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
    const result = await db.transaction(async (tx) => {
      const existing = await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
      if (existing) {
        throw new Error('Ya hay una caja abierta. Ciérrala primero.');
      }

      // Carry-over: get expected opening amount from last closed session.
      // When posTokenId is null (admin/no-device session), skip carry-over logic
      // and set expected to 0 with no prior close.
      const carryover = ctx.tokenId
        ? await getOpeningExpected(tx, ctx.organizationId, ctx.tokenId)
        : { expected: 0, priorCloseExists: false };

      const { expected, priorCloseExists } = carryover;

      // Validate explanation enforcement rule (R3 / R5).
      const validation = validateOpenCarryover({
        priorCloseExists,
        counted,
        expected,
        explanation: body.explanation,
      });

      if (!validation.valid) {
        // Throw with a sentinel so the outer catch can distinguish 422 vs 400.
        const err = new Error(validation.message);
        (err as Error & { statusCode?: number }).statusCode = validation.code;
        throw err;
      }

      const { difference } = validation;

      const [created] = await tx
        .insert(cashSessionsSchema)
        .values({
          organizationId: ctx.organizationId,
          posTokenId: ctx.tokenId,
          openingAmount: toMoney(counted),
          openedBy: attribution,
          status: 'open',
          notes: body.notes ?? null,
          // Carry-over columns (R1 / R3 / R4 — always set for POS sessions)
          openingExpected: ctx.tokenId ? toMoney(expected) : null,
          openingDifference: ctx.tokenId ? toMoney(difference) : null,
          openingExplanation: body.explanation?.trim() || null,
        })
        .returning();

      if (!created) {
        throw new Error('No se pudo abrir la caja');
      }
      return { session: created, expected, difference, priorCloseExists };
    });

    const { session, expected, difference, priorCloseExists: _priorCloseExists } = result;

    // Audit log: enrich with open-time discrepancy metadata when difference ≠ 0 (R4).
    const hasDiscrepancy = difference !== 0;
    await logAction({
      organizationId: ctx.organizationId,
      actor: resolvePosActor(ctx),
      action: hasDiscrepancy ? 'cash_session_open_discrepancy' : 'cash.opened',
      entityType: 'cash_session',
      entityId: session.id,
      after: {
        id: session.id,
        openingAmount: session.openingAmount,
        openedBy: session.openedBy,
        notes: session.notes,
        openingExpected: expected,
        openingDifference: difference,
        openingExplanation: session.openingExplanation,
      },
      metadata: {
        cashierName: ctx.cashierName,
        source: ctx.source,
        ...(hasDiscrepancy && { openingDifference: difference }),
      },
      ip:
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || null,
      userAgent: req.headers.get('user-agent'),
    });

    return NextResponse.json(toPosCashSession(session), { status: 201 });
  } catch (err) {
    const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 400;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al abrir caja' },
      { status: statusCode },
    );
  }
}
