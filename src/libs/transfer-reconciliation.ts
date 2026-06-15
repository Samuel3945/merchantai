import { eq } from 'drizzle-orm';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  salePaymentsSchema,
  salesSchema,
  transferReconciliationsSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Methods whose money lands in a bank/wallet account (not the physical drawer)
// and therefore must be reconciled against the statement. Cash is the arqueo,
// handled by cash_movements. Tarjeta/datáfono settles through the acquirer on
// its own cycle and is intentionally OUT of scope for now. The fiado credit
// portion is not money-in at all.
const CASH_TOKENS = ['efectivo', 'cash'];
const CARD_TOKENS = ['tarjeta', 'datafono', 'datáfono', 'card'];

export function methodNeedsReconciliation(method: string | null): boolean {
  const m = (method ?? '').trim().toLowerCase();
  if (!m) {
    return false;
  }
  if (/fiado/.test(m)) {
    return false;
  }
  if (CASH_TOKENS.some(t => m.includes(t))) {
    return false;
  }
  if (CARD_TOKENS.some(t => m.includes(t))) {
    return false;
  }
  return true;
}

// Populates the reconciliation ledger for a sale's transfer-like payments.
//
// Called best-effort AFTER the sale transaction commits — exactly like
// recordCashMovement. A failure here must never roll back a committed sale, and
// the UNIQUE(sale_payment_id) index + onConflictDoNothing make it safe to retry
// (the offline POS sync replays sales). Everything is derived from the sale row,
// so all three sale entry points (createSale, pos/sales, pos/sync) share it.
export async function recordSaleTransferReconciliations(
  saleId: string,
): Promise<void> {
  const [sale] = await db
    .select({
      organizationId: salesSchema.organizationId,
      posTokenId: salesSchema.posTokenId,
    })
    .from(salesSchema)
    .where(eq(salesSchema.id, saleId))
    .limit(1);
  if (!sale) {
    return;
  }

  const payments = await db
    .select({
      id: salePaymentsSchema.id,
      method: salePaymentsSchema.method,
      amount: salePaymentsSchema.amount,
      reference: salePaymentsSchema.reference,
    })
    .from(salePaymentsSchema)
    .where(eq(salePaymentsSchema.saleId, saleId));

  const reconcilable = payments.filter(p => methodNeedsReconciliation(p.method));
  if (reconcilable.length === 0) {
    return;
  }

  // Scope the session lookup to the device that made the sale (null = admin).
  const session = await findOpenSession(
    db,
    sale.organizationId,
    sale.posTokenId,
  );

  await db
    .insert(transferReconciliationsSchema)
    .values(
      reconcilable.map(p => ({
        organizationId: sale.organizationId,
        salePaymentId: p.id,
        posTokenId: sale.posTokenId ?? null,
        cashSessionId: session?.id ?? null,
        method: p.method,
        expectedAmount: toMoney(p.amount),
        reference: p.reference ?? null,
      })),
    )
    .onConflictDoNothing();
}

// Creates ONE reconciliation row for a digital fiado abono and returns its id so
// the covered fiado_movements can link to it (via transfer_reconciliation_id,
// the digital twin of cash_movement_id). One real transfer = one row, even when
// the abono pays down several fiados. Runs INSIDE the abono transaction because
// the movements must link it; the insert is trivial so the rollback risk is low.
export async function createFiadoTransferReconciliation(
  executor: Executor,
  args: {
    organizationId: string;
    method: string;
    expectedAmount: number | string;
    reference?: string | null;
    posTokenId?: string | null;
    cashSessionId?: string | null;
  },
): Promise<string | null> {
  const [row] = await executor
    .insert(transferReconciliationsSchema)
    .values({
      organizationId: args.organizationId,
      method: args.method,
      expectedAmount: toMoney(args.expectedAmount),
      reference: args.reference ?? null,
      posTokenId: args.posTokenId ?? null,
      cashSessionId: args.cashSessionId ?? null,
    })
    .returning({ id: transferReconciliationsSchema.id });
  return row?.id ?? null;
}
