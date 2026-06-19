import type { db } from '@/libs/DB';
import { and, eq } from 'drizzle-orm';
import {
  isCashMethod,
  recordReclassificationMovement,
  toMoney,
} from '@/libs/cash-helpers';
import {
  createReconciliationForPayment,
  methodNeedsReconciliation,
  syncPendingReconciliationAmount,
} from '@/libs/transfer-reconciliation';
import { salePaymentsSchema, salesSchema } from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ReclassifyArgs = {
  organizationId: string;
  // The existing sale_payments row to move money OUT of.
  salePaymentId: string;
  toMethod: string;
  amount: number | string;
  // The current OPEN session — where the signed cash delta posts. Never the
  // sale's original (possibly closed) session.
  currentSessionId: string;
  createdBy: string;
};

export type ReclassifyResult
  = | { ok: true }
    | { ok: false; error: string };

// Corrects a mis-entered payment split: moves `amount` from one method to
// another on a sale, keeping the total (and stock) untouched. It never edits a
// posted cash movement — instead it posts a SIGNED compensating reclassification
// movement for the cash delta, and creates/syncs the transfer reconciliations.
export async function reclassifyPayment(
  executor: Executor,
  args: ReclassifyArgs,
): Promise<ReclassifyResult> {
  const [src] = await executor
    .select({
      id: salePaymentsSchema.id,
      method: salePaymentsSchema.method,
      amount: salePaymentsSchema.amount,
      saleId: salePaymentsSchema.saleId,
      posTokenId: salesSchema.posTokenId,
    })
    .from(salePaymentsSchema)
    .innerJoin(salesSchema, eq(salesSchema.id, salePaymentsSchema.saleId))
    .where(
      and(
        eq(salePaymentsSchema.id, args.salePaymentId),
        eq(salesSchema.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!src) {
    return { ok: false, error: 'Pago no encontrado' };
  }

  const fromMethod = src.method;
  const toMethod = args.toMethod.trim();
  if (!toMethod) {
    return { ok: false, error: 'Método destino requerido' };
  }
  if (toMethod.toLowerCase() === fromMethod.toLowerCase()) {
    return { ok: false, error: 'El método destino debe ser distinto al origen' };
  }

  const moveAmt = Number.parseFloat(toMoney(args.amount));
  const srcAmt = Number.parseFloat(src.amount) || 0;
  if (!Number.isFinite(moveAmt) || moveAmt <= 0) {
    return { ok: false, error: 'El monto debe ser mayor a 0' };
  }
  if (moveAmt > srcAmt) {
    return {
      ok: false,
      error: 'No podés reclasificar más de lo que tiene ese pago',
    };
  }

  // ── 1. sale_payments: reduce/remove the source, add the destination. The sale
  // total is unchanged — only the method split moves.
  const remaining = Number.parseFloat((srcAmt - moveAmt).toFixed(2));
  if (remaining <= 0) {
    await executor
      .delete(salePaymentsSchema)
      .where(eq(salePaymentsSchema.id, src.id));
  } else {
    await executor
      .update(salePaymentsSchema)
      .set({ amount: toMoney(remaining) })
      .where(eq(salePaymentsSchema.id, src.id));
  }
  const [dest] = await executor
    .insert(salePaymentsSchema)
    .values({
      saleId: src.saleId,
      method: toMethod,
      amount: toMoney(moveAmt),
    })
    .returning({ id: salePaymentsSchema.id });

  // ── 2. Cash delta: signed compensating movement (only when cash is involved).
  const fromCash = isCashMethod(fromMethod);
  const toCash = isCashMethod(toMethod);
  let cashDelta = 0;
  if (fromCash && !toCash) {
    cashDelta = -moveAmt; // cash leaves the drawer — it was really a transfer
  } else if (!fromCash && toCash) {
    cashDelta = moveAmt; // cash enters the drawer
  }
  if (cashDelta !== 0) {
    await recordReclassificationMovement(executor, {
      organizationId: args.organizationId,
      sessionId: args.currentSessionId,
      amount: cashDelta,
      reason: `Reclasificación: ${fromMethod} → ${toMethod}`,
      saleId: src.saleId,
      createdBy: args.createdBy,
    });
  }

  // ── 3. Transfer reconciliations.
  // Source reduced and still a reconcilable transfer → sync its pending row. If
  // the source was deleted, its reconciliation is gone via FK cascade.
  if (methodNeedsReconciliation(fromMethod) && remaining > 0) {
    await syncPendingReconciliationAmount(executor, {
      salePaymentId: src.id,
      organizationId: args.organizationId,
      expectedAmount: remaining,
    });
  }
  // Destination is a reconcilable transfer → create its row to confirm later.
  if (dest && methodNeedsReconciliation(toMethod)) {
    await createReconciliationForPayment(executor, {
      organizationId: args.organizationId,
      salePaymentId: dest.id,
      method: toMethod,
      expectedAmount: moveAmt,
      posTokenId: src.posTokenId,
    });
  }

  return { ok: true };
}

export type PosReclassifyArgs = {
  organizationId: string;
  // The device's CURRENT open cash session — where the cash delta will land.
  session: { id: string; openedAt: Date; posTokenId: string | null };
  salePaymentId: string;
  toMethod: string;
  amount: number | string;
  createdBy: string;
};

// POS-side "error de carga" correction: the cashier fixes a mis-entered split
// (e.g. a mixed cash/transfer payment) on a sale from THEIR CURRENT shift, so
// the compensating cash delta posts into the live session and the caja stays
// cuadrada. Correcting a sale from a past/closed shift is rejected on purpose —
// its delta would land in today's session and re-open a descuadre, which is the
// exact thing this flow exists to prevent. In-shift = same device + the sale was
// created at or after the open session started.
export async function reclassifyPosSalePayment(
  executor: Executor,
  args: PosReclassifyArgs,
): Promise<ReclassifyResult> {
  const [row] = await executor
    .select({
      saleCreatedAt: salesSchema.createdAt,
      salePosTokenId: salesSchema.posTokenId,
    })
    .from(salePaymentsSchema)
    .innerJoin(salesSchema, eq(salesSchema.id, salePaymentsSchema.saleId))
    .where(
      and(
        eq(salePaymentsSchema.id, args.salePaymentId),
        eq(salesSchema.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!row) {
    return { ok: false, error: 'Pago no encontrado' };
  }

  const sameDevice
    = (row.salePosTokenId ?? null) === (args.session.posTokenId ?? null);
  const withinShift
    = row.saleCreatedAt.getTime() >= args.session.openedAt.getTime();
  if (!sameDevice || !withinShift) {
    return { ok: false, error: 'Solo podés corregir una venta del turno actual' };
  }

  return reclassifyPayment(executor, {
    organizationId: args.organizationId,
    salePaymentId: args.salePaymentId,
    toMethod: args.toMethod,
    amount: args.amount,
    currentSessionId: args.session.id,
    createdBy: args.createdBy,
  });
}
