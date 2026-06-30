import type { db } from '@/libs/DB';
import { and, eq } from 'drizzle-orm';
import {
  isCashMethod,
  recordReclassificationMovement,
  toMoney,
} from '@/libs/cash-helpers';
import { createCredito } from '@/libs/creditos';
import { isCreditoMethod } from '@/libs/creditos-math';
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

// ── Full re-split ────────────────────────────────────────────────────────────
// A correction can do more than move one amount between two methods: the cashier
// re-enters the WHOLE payment using the same POS checkout they use to charge
// (e.g. a sale booked as full cash was really cash + transfer). This applies the
// new split as a unit while staying exactly equivalent to a sequence of
// reclassifyPayment calls — the sale total never moves, only the NET cash delta
// posts to the live session, and transfer reconciliations are rebuilt only for
// the methods that actually changed.

export type ResplitPaymentInput = {
  method: string;
  amount: number | string;
  reference?: string | null;
  changeGiven?: number | string;
};

export type ResplitArgs = {
  organizationId: string;
  saleId: string;
  payments: ResplitPaymentInput[];
  // The current OPEN session — where the signed net cash delta posts. Never the
  // sale's original (possibly closed) session.
  currentSessionId: string;
  createdBy: string;
  // When the correction turns part of the sale into fiado, this carries the
  // '[CREDITO] Nombre:… | Tel:…' segment so the debt is booked with a debtor.
  notes?: string | null;
  // Manual credit due date ('YYYY-MM-DD'); null falls back to the org term.
  dueDate?: string | null;
};

// Identity of a payment row for diffing old vs new. Two rows with the same key
// are the SAME payment and must be left untouched, so an already-confirmed
// transfer reconciliation is never reset to pending by a no-op correction.
function paymentIdentity(p: {
  method: string;
  amount: number | string;
  reference: string | null;
  changeGiven: number | string;
}): string {
  return [
    p.method.trim().toLowerCase(),
    toMoney(p.amount),
    (p.reference ?? '').trim(),
    toMoney(p.changeGiven),
  ].join('|');
}

export async function resplitPayment(
  executor: Executor,
  args: ResplitArgs,
): Promise<ReclassifyResult> {
  const [sale] = await executor
    .select({
      id: salesSchema.id,
      total: salesSchema.total,
      posTokenId: salesSchema.posTokenId,
      notes: salesSchema.notes,
    })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.id, args.saleId),
        eq(salesSchema.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!sale) {
    return { ok: false, error: 'Venta no encontrada' };
  }

  // ── Normalize + validate the desired split. The total is an invariant: a
  // correction fixes HOW the customer paid, never how much.
  const desired = args.payments.map(p => ({
    method: p.method.trim(),
    amount: Number.parseFloat(toMoney(p.amount)),
    reference: p.reference?.trim() ? p.reference.trim() : null,
    changeGiven: Number.parseFloat(toMoney(p.changeGiven ?? 0)),
  }));
  if (desired.length === 0) {
    return { ok: false, error: 'Indicá al menos un método de pago' };
  }
  for (const d of desired) {
    if (!d.method) {
      return { ok: false, error: 'Método de pago requerido' };
    }
    if (!Number.isFinite(d.amount) || d.amount <= 0) {
      return { ok: false, error: 'Cada pago debe ser mayor a 0' };
    }
  }
  const newTotal = Number.parseFloat(
    desired.reduce((s, d) => s + d.amount, 0).toFixed(2),
  );
  const saleTotal = Number.parseFloat(sale.total) || 0;
  if (Math.abs(newTotal - saleTotal) > 0.01) {
    return {
      ok: false,
      error: `Los pagos deben sumar el total de la venta (${toMoney(saleTotal)})`,
    };
  }

  const existing = await executor
    .select({
      id: salePaymentsSchema.id,
      method: salePaymentsSchema.method,
      amount: salePaymentsSchema.amount,
      reference: salePaymentsSchema.reference,
      changeGiven: salePaymentsSchema.changeGiven,
    })
    .from(salePaymentsSchema)
    .where(eq(salePaymentsSchema.saleId, sale.id));

  // ── Diff by identity. Rows present in both stay as-is; rows only in the old
  // set are removed (FK cascade drops their reconciliations); rows only in the
  // new set are inserted.
  const leftoverExisting = [...existing];
  const toInsert: typeof desired = [];
  for (const d of desired) {
    const key = paymentIdentity(d);
    const idx = leftoverExisting.findIndex(e => paymentIdentity(e) === key);
    if (idx >= 0) {
      leftoverExisting.splice(idx, 1);
    } else {
      toInsert.push(d);
    }
  }
  for (const stale of leftoverExisting) {
    await executor
      .delete(salePaymentsSchema)
      .where(eq(salePaymentsSchema.id, stale.id));
  }

  // ── Net cash delta over the WHOLE split, so the compensating movement equals
  // what a chain of reclassifyPayment calls would have posted.
  const cashTotal = (rows: { method: string; amount: number | string }[]) =>
    rows.reduce(
      (s, r) =>
        s + (isCashMethod(r.method) ? Number.parseFloat(String(r.amount)) || 0 : 0),
      0,
    );
  const cashDelta = Number.parseFloat(
    (cashTotal(desired) - cashTotal(existing)).toFixed(2),
  );

  const inserted: { id: string; method: string; amount: string }[] = [];
  for (const d of toInsert) {
    const [row] = await executor
      .insert(salePaymentsSchema)
      .values({
        saleId: sale.id,
        method: d.method,
        amount: toMoney(d.amount),
        changeGiven: toMoney(d.changeGiven),
        reference: d.reference,
      })
      .returning({
        id: salePaymentsSchema.id,
        method: salePaymentsSchema.method,
        amount: salePaymentsSchema.amount,
      });
    if (row) {
      inserted.push(row);
    }
  }

  if (cashDelta !== 0) {
    await recordReclassificationMovement(executor, {
      organizationId: args.organizationId,
      sessionId: args.currentSessionId,
      amount: cashDelta,
      reason: 'Corrección de método de pago',
      saleId: sale.id,
      createdBy: args.createdBy,
    });
  }

  // ── Build reconciliations only for the genuinely new transfer rows. Unchanged
  // transfer rows keep theirs (including a confirmed status); removed ones lost
  // theirs via cascade.
  for (const row of inserted) {
    if (methodNeedsReconciliation(row.method)) {
      await createReconciliationForPayment(executor, {
        organizationId: args.organizationId,
        salePaymentId: row.id,
        method: row.method,
        expectedAmount: row.amount,
        posTokenId: sale.posTokenId,
      });
    }
  }

  // ── Fiado: if the corrected split now owes part on credito, book the debt so
  // the money owed exists in the ledger (otherwise the credito payment row would
  // claim "paid" with no debtor). The correction only ever STARTS from a
  // non-credito sale (the button is hidden on credito sales), so there is no
  // prior credito to settle — createCredito is idempotent on sale_id regardless.
  const creditoAmount = Number.parseFloat(
    desired
      .reduce((s, d) => s + (isCreditoMethod(d.method) ? d.amount : 0), 0)
      .toFixed(2),
  );
  if (creditoAmount > 0) {
    // Replace only the [CREDITO] note segment; keep any other ([FACTURA] …).
    const kept = (sale.notes ?? '')
      .split(' || ')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('[CREDITO]'));
    const creditoNote = (args.notes ?? '').trim();
    const mergedNotes
      = [creditoNote, ...kept].filter(Boolean).join(' || ') || null;
    await executor
      .update(salesSchema)
      .set({ notes: mergedNotes })
      .where(eq(salesSchema.id, sale.id));
    await createCredito(executor, {
      organizationId: args.organizationId,
      saleId: sale.id,
      originalAmount: creditoAmount,
      dueDate: args.dueDate ?? null,
      createdBy: args.createdBy,
      notes: mergedNotes,
    });
  }

  return { ok: true };
}

export type PosResplitArgs = {
  organizationId: string;
  // The device's CURRENT open cash session — where the net cash delta lands.
  session: { id: string; openedAt: Date; posTokenId: string | null };
  saleId: string;
  payments: ResplitPaymentInput[];
  createdBy: string;
  // '[CREDITO] …' segment when the correction adds fiado (see ResplitArgs.notes).
  notes?: string | null;
  // Manual credit due date ('YYYY-MM-DD'); null falls back to the org term.
  dueDate?: string | null;
};

// POS-side full re-split. Same in-shift guard as reclassifyPosSalePayment:
// correcting a past/closed-shift sale is rejected because its cash delta would
// land in today's session and re-open a descuadre.
export async function resplitPosSalePayment(
  executor: Executor,
  args: PosResplitArgs,
): Promise<ReclassifyResult> {
  const [sale] = await executor
    .select({
      saleCreatedAt: salesSchema.createdAt,
      salePosTokenId: salesSchema.posTokenId,
    })
    .from(salesSchema)
    .where(
      and(
        eq(salesSchema.id, args.saleId),
        eq(salesSchema.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  if (!sale) {
    return { ok: false, error: 'Venta no encontrada' };
  }

  const sameDevice
    = (sale.salePosTokenId ?? null) === (args.session.posTokenId ?? null);
  const withinShift
    = sale.saleCreatedAt.getTime() >= args.session.openedAt.getTime();
  if (!sameDevice || !withinShift) {
    return { ok: false, error: 'Solo podés corregir una venta del turno actual' };
  }

  return resplitPayment(executor, {
    organizationId: args.organizationId,
    saleId: args.saleId,
    payments: args.payments,
    currentSessionId: args.session.id,
    createdBy: args.createdBy,
    notes: args.notes,
    dueDate: args.dueDate,
  });
}
