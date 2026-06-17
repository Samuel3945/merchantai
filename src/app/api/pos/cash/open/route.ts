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
import {
  getOrCreatePendingAccount,
  recordContainerTransfer,
  recordHandoverMovement,
  resolveSweepDestination,
} from '@/libs/treasury';
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
      // treasury-sweep-model slice 1: read-then-write ordering — carryover (read)
      // MUST run before the session insert (write) and before the sweep insert.
      const carryover = ctx.tokenId
        ? await getOpeningExpected(tx, ctx.organizationId, ctx.tokenId)
        : { expected: 0, priorCloseExists: false, lastClosedSessionId: null };

      const { expected, priorCloseExists, lastClosedSessionId } = carryover;

      // Cashier is never blocked (ADR-2, treasury-sweep-model slice 1).
      // The open-time sweep handles shortfalls automatically.
      const validation = validateOpenCarryover({
        priorCloseExists,
        counted,
        expected,
        explanation: body.explanation,
      });

      // validation.valid is always true after slice 1 — kept for type narrowing
      if (!validation.valid) {
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
          // Carry-over columns: only meaningful when a prior close exists to
          // reconcile against. A first-ever open (no prior close) has no
          // carry-over expectation, so these stay null — it is NOT a discrepancy.
          openingExpected: priorCloseExists ? toMoney(expected) : null,
          openingDifference: priorCloseExists ? toMoney(difference) : null,
          // Accept and store the legacy explanation field from older POS devices
          // (ADR-3 backward-compat). Never required — open is never blocked.
          openingExplanation: body.explanation?.trim() || null,
        })
        .returning();

      if (!created) {
        throw new Error('No se pudo abrir la caja');
      }

      // treasury-sweep-model: open-time shortfall sweep.
      // Emit a type='handover' movement keyed to the LAST CLOSED session id
      // (not the newly-opened session) when Δ<0. Amount = |Δ| (the shortfall).
      // Keying to the last-closed session makes both subtraction paths work:
      //   • getOpeningExpected subtracts handovers on last.id
      //   • getTreasuryPosition subtracts handoverBySession on lastSessionIds
      // Read-then-write ordering is enforced: carryover was read above before
      // this write, inside the same tx.
      //
      // slice 2: If the caja has a configured cofre destination (resolveSweepDestination),
      // the handover goes to transito and a companion transfer transito→cofre is emitted
      // in the same tx (handoverMovementId set → getRemainingForHandover = 0, nothing
      // left in the queue). NO confirmation prompt. When null → falls back to Pendiente
      // de ubicar (slice-1 path, visible in the placement queue).
      if (priorCloseExists && lastClosedSessionId && difference < 0) {
        const sweepAmount = Math.abs(difference);
        const pendingAccount = await getOrCreatePendingAccount(tx, ctx.organizationId, attribution);
        const sweepRow = await recordHandoverMovement(tx, {
          organizationId: ctx.organizationId,
          toAccountId: pendingAccount.id,
          amount: sweepAmount,
          cashSessionId: lastClosedSessionId,
          createdBy: attribution,
        });

        // Auto-route to configured cofre (two-step: handover already went to transito;
        // now place it via a transfer transito→cofre in the same tx so the queue shows 0).
        const destination = await resolveSweepDestination(tx, ctx.organizationId, ctx.tokenId);
        if (destination) {
          await recordContainerTransfer(tx, {
            organizationId: ctx.organizationId,
            fromAccountId: pendingAccount.id,
            toAccountId: destination.accountId,
            amount: sweepAmount,
            createdBy: attribution,
            handoverMovementId: sweepRow.id,
          });
        }
      }

      return { session: created };
    });

    const { session } = result;

    // A real open-time discrepancy requires a prior close to deviate from (R4):
    // it surfaces as a non-null, non-zero opening_difference. A first-ever open
    // with a starting float is NOT a discrepancy — flagging it would pollute the
    // fraud signal with false positives.
    const storedDiff = session.openingDifference != null
      ? Number.parseFloat(session.openingDifference)
      : 0;
    const hasDiscrepancy = storedDiff !== 0;
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
        openingExpected: session.openingExpected,
        openingDifference: session.openingDifference,
        openingExplanation: session.openingExplanation,
      },
      metadata: {
        cashierName: ctx.cashierName,
        source: ctx.source,
        ...(hasDiscrepancy && { openingDifference: session.openingDifference }),
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
