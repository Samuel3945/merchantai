import { NextResponse } from 'next/server';
import { logAction, resolvePosActor } from '@/libs/audit-log';
import { findOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { resplitPosSalePayment } from '@/libs/payment-reclassification';
import { requirePosAuth } from '@/libs/pos-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cashier-app payment correction via the full POS checkout. The cashier re-enters
// the whole payment for a sale from their CURRENT shift (e.g. a sale booked as
// full cash was really cash + transfer). The sale total never changes — only the
// method split — and the net cash delta posts into the live session so the caja
// stays cuadrada. Wire DTO is snake_case to match the device contract.
type ResplitBody = {
  sale_id?: string;
  payments?: Array<{
    method?: string;
    amount?: number | string;
    reference?: string | null;
    change_given?: number | string;
  }>;
  // '[CREDITO] Nombre:… | Tel:…' segment, only when the correction adds fiado.
  notes?: string | null;
  // Manual credit due date ('YYYY-MM-DD') chosen by the cashier at correction.
  due_date?: string | null;
};

export async function POST(req: Request): Promise<NextResponse> {
  const { ctx, errorResponse } = await requirePosAuth(req);
  if (errorResponse) {
    return errorResponse;
  }

  let body: ResplitBody;
  try {
    body = (await req.json()) as ResplitBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const saleId = body.sale_id?.trim();
  if (!saleId) {
    return NextResponse.json({ error: 'sale_id es requerido' }, { status: 400 });
  }
  if (!Array.isArray(body.payments) || body.payments.length === 0) {
    return NextResponse.json(
      { error: 'payments es requerido' },
      { status: 400 },
    );
  }

  const payments = body.payments.map(p => ({
    method: String(p.method ?? '').trim(),
    amount: p.amount ?? 0,
    reference: p.reference ?? null,
    changeGiven: p.change_given ?? 0,
  }));

  try {
    await db.transaction(async (tx) => {
      const open = await findOpenSession(tx, ctx.organizationId, ctx.tokenId);
      if (!open) {
        throw new Error('No hay caja abierta. Abrí la caja primero.');
      }
      const result = await resplitPosSalePayment(tx, {
        organizationId: ctx.organizationId,
        session: {
          id: open.id,
          openedAt: open.openedAt,
          posTokenId: open.posTokenId,
        },
        saleId,
        payments,
        createdBy: ctx.cashierName || 'Cajero',
        notes: body.notes?.trim() || null,
        dueDate: body.due_date ?? null,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error al corregir el pago' },
      { status: 400 },
    );
  }

  // Audit after commit — a bookkeeping log must never roll back the correction.
  await logAction({
    organizationId: ctx.organizationId,
    actor: resolvePosActor(ctx),
    action: 'pos.sale.resplit',
    entityType: 'sale',
    entityId: saleId,
    after: {
      payments: payments.map(p => ({ method: p.method, amount: String(p.amount) })),
    },
  });

  return NextResponse.json({ ok: true });
}
