import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { findOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { reclassifyPosSalePayment } from '@/libs/payment-reclassification';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cashier-app "error de carga" correction. The cashier fixes a mis-entered
// payment split (e.g. a mixed cash/transfer payment booked wrong) on a sale from
// their CURRENT shift. The compensating cash delta posts into the live session,
// so the caja stays cuadrada — the error never reaches close as a descuadre.
// Wire DTO is snake_case to match the device contract.
type ReclassifyBody = {
  sale_payment_id?: string;
  to_method?: string;
  amount?: number | string;
};

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: ReclassifyBody;
  try {
    body = (await req.json()) as ReclassifyBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const salePaymentId = body.sale_payment_id?.trim();
  const toMethod = body.to_method?.trim();
  if (!salePaymentId) {
    return NextResponse.json(
      { error: 'sale_payment_id es requerido' },
      { status: 400 },
    );
  }
  if (!toMethod) {
    return NextResponse.json({ error: 'to_method es requerido' }, { status: 400 });
  }

  try {
    await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
      if (!open) {
        throw new Error('No hay caja abierta. Abrí la caja primero.');
      }
      const result = await reclassifyPosSalePayment(tx, {
        organizationId: ctx.organizationId,
        session: {
          id: open.id,
          openedAt: open.openedAt,
          posTokenId: open.posTokenId,
        },
        salePaymentId,
        toMethod,
        amount: body.amount ?? 0,
        createdBy: ctx.cashierName || 'Cajero',
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al reclasificar' },
      { status: 400 },
    );
  }

  // Audit after commit — a bookkeeping log must never roll back the correction.
  await logAction({
    organizationId: ctx.organizationId,
    actor: resolvePosActor(ctx),
    action: 'pos.sale.reclassified',
    entityType: 'sale_payment',
    entityId: salePaymentId,
    after: { toMethod, amount: String(body.amount ?? 0) },
  });

  return NextResponse.json({ ok: true });
}
