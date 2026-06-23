import { and, eq } from 'drizzle-orm';
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
import {
  getBlockCloseOnInvestigation,
  hasOpenInvestigations,
} from '@/libs/transfer-reconciliation';
import { normalizeIdempotencyKey } from '@/libs/uuid';
// treasury-sweep-model: at-close handover retired (slice 1). Flag/toggle retired (slice 2).
import { cashSessionsSchema, posTokensSchema } from '@/models/Schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CloseBody = {
  countedAmount?: number | string;
  notes?: string | null;
  // Offline-authoritative device key (optional — legacy clients omit it). Keys
  // the close to a specific session and makes a replayed close idempotent.
  clientSessionId?: string | null;
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

  // A present-but-malformed key normalizes to null → legacy close by token.
  const clientSessionId = normalizeIdempotencyKey(body.clientSessionId);

  // Idempotent close (belt): re-closing the same client_session_id returns the
  // already-closed immutable record instead of erroring with "no open caja"
  // (per the immutable-closed-records reconciliation design). A key we have
  // never seen means the OPEN event has not synced yet — reject so the outbox
  // retries it in order (open-before-close).
  if (clientSessionId) {
    const [existingByClient] = await db
      .select()
      .from(cashSessionsSchema)
      .where(
        and(
          eq(cashSessionsSchema.organizationId, ctx.organizationId),
          eq(cashSessionsSchema.clientSessionId, clientSessionId),
        ),
      )
      .limit(1);
    if (!existingByClient) {
      return NextResponse.json(
        {
          error:
            'No hay caja con ese client_session_id; sincroniza la apertura primero.',
        },
        { status: 404 },
      );
    }
    if (existingByClient.status === 'closed') {
      return NextResponse.json(toPosCashSession(existingByClient), {
        status: 200,
      });
    }
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
    const session = await db.transaction(async (tx) => {
      // Device close targets its OWN session by client_session_id; legacy close
      // falls back to the one open session for the token.
      const open = clientSessionId
        ? (
            await tx
              .select()
              .from(cashSessionsSchema)
              .where(
                and(
                  eq(cashSessionsSchema.organizationId, ctx.organizationId),
                  eq(cashSessionsSchema.clientSessionId, clientSessionId),
                  eq(cashSessionsSchema.status, 'open'),
                ),
              )
              .limit(1)
          )[0]
        : await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
      if (!open) {
        throw new Error('No hay caja abierta para cerrar.');
      }

      // Block-close guard (toggle A): if the org enabled this setting and there
      // are open investigations (not_arrived rows), reject the close so the
      // cashier resolves them first.
      const blockClose = await getBlockCloseOnInvestigation(tx, ctx.organizationId);
      if (blockClose) {
        const hasOpen = await hasOpenInvestigations(tx, ctx.organizationId);
        if (hasOpen) {
          throw new Error(
            'Hay transferencias en investigación pendientes. Resuélvelas antes de cerrar la caja.',
          );
        }
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
          // Stable identity for live name resolution. NULL = device-only turn
          // (no operator): the responsable is the caja itself, shown by its
          // current live name so a rename never splits the history.
          closedByActorId: ctx.cashierId ?? null,
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

      // treasury-sweep-model: at-close handover retired. Sweep fires at open time.

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
