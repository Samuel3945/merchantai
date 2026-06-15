import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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

// ── Reconciliation surface: read + lifecycle ─────────────────────────────────
// The owner (or an account holder) confirms incoming transfers against the
// statement. Every read and mutation is scoped by organizationId for tenant
// isolation. The happy path is bulkConfirmPending ("everything matched"); the
// owner only marks the exceptions.

export type TransferReconciliation
  = typeof transferReconciliationsSchema.$inferSelect;
export type ReconciliationStatus = TransferReconciliation['status'];

export type ReconciliationFilter = {
  organizationId: string;
  status?: ReconciliationStatus;
  from?: Date;
  to?: Date;
};

function filterConds(filter: ReconciliationFilter) {
  const conds = [
    eq(transferReconciliationsSchema.organizationId, filter.organizationId),
  ];
  if (filter.status) {
    conds.push(eq(transferReconciliationsSchema.status, filter.status));
  }
  if (filter.from) {
    conds.push(gte(transferReconciliationsSchema.createdAt, filter.from));
  }
  if (filter.to) {
    conds.push(lte(transferReconciliationsSchema.createdAt, filter.to));
  }
  return conds;
}

export async function listReconciliations(
  executor: Executor,
  filter: ReconciliationFilter,
): Promise<TransferReconciliation[]> {
  return executor
    .select()
    .from(transferReconciliationsSchema)
    .where(and(...filterConds(filter)))
    .orderBy(desc(transferReconciliationsSchema.createdAt));
}

// The "you have X transfers pending ($Y)" overview that drives the confirm-all
// affordance and (later) the multi-store nudge.
export async function countPendingReconciliations(
  executor: Executor,
  filter: Omit<ReconciliationFilter, 'status'>,
): Promise<{ count: number; total: number }> {
  const [row] = await executor
    .select({
      count: sql<number>`COUNT(*)::int`,
      total: sql<string>`COALESCE(SUM(${transferReconciliationsSchema.expectedAmount}), 0)::text`,
    })
    .from(transferReconciliationsSchema)
    .where(
      and(...filterConds({ ...filter, status: 'pending' })),
    );
  return {
    count: Number(row?.count ?? 0),
    total: Number.parseFloat(row?.total ?? '0') || 0,
  };
}

type MutationBase = {
  id: string;
  organizationId: string;
  reconciledBy: string;
};

// Confirms a transfer landed. arrivedAmount defaults to the expected amount (a
// plain "yes, it matched"). Works from any non-confirmed state, so a late
// arrival is just a not_arrived → confirmed transition.
export async function confirmReconciliation(
  executor: Executor,
  args: MutationBase & { arrivedAmount?: number | string | null },
): Promise<TransferReconciliation | null> {
  const [row] = await executor
    .update(transferReconciliationsSchema)
    .set({
      status: 'confirmed',
      arrivedAmount:
        args.arrivedAmount != null
          ? toMoney(args.arrivedAmount)
          : sql`${transferReconciliationsSchema.expectedAmount}`,
      reconciledBy: args.reconciledBy,
      reconciledAt: new Date(),
    })
    .where(
      and(
        eq(transferReconciliationsSchema.id, args.id),
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

// Marks a transfer that never landed. Resolution (receivable / loss /
// cashier_liability) is a separate phase; this only records the fact.
export async function markReconciliationNotArrived(
  executor: Executor,
  args: MutationBase & { note?: string | null },
): Promise<TransferReconciliation | null> {
  const [row] = await executor
    .update(transferReconciliationsSchema)
    .set({
      status: 'not_arrived',
      reconciledBy: args.reconciledBy,
      reconciledAt: new Date(),
      note: args.note ?? null,
    })
    .where(
      and(
        eq(transferReconciliationsSchema.id, args.id),
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

// Marks a transfer that landed for a different amount than expected.
export async function markReconciliationMismatch(
  executor: Executor,
  args: MutationBase & { arrivedAmount: number | string; note?: string | null },
): Promise<TransferReconciliation | null> {
  const [row] = await executor
    .update(transferReconciliationsSchema)
    .set({
      status: 'mismatch',
      arrivedAmount: toMoney(args.arrivedAmount),
      reconciledBy: args.reconciledBy,
      reconciledAt: new Date(),
      note: args.note ?? null,
    })
    .where(
      and(
        eq(transferReconciliationsSchema.id, args.id),
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

// The happy path: confirm every pending transfer in the period (or a given
// subset of ids). Returns how many rows were confirmed.
export async function bulkConfirmPending(
  executor: Executor,
  args: {
    organizationId: string;
    reconciledBy: string;
    ids?: string[];
    from?: Date;
    to?: Date;
  },
): Promise<number> {
  const conds = [
    eq(transferReconciliationsSchema.organizationId, args.organizationId),
    eq(transferReconciliationsSchema.status, 'pending'),
  ];
  if (args.ids && args.ids.length > 0) {
    conds.push(inArray(transferReconciliationsSchema.id, args.ids));
  }
  if (args.from) {
    conds.push(gte(transferReconciliationsSchema.createdAt, args.from));
  }
  if (args.to) {
    conds.push(lte(transferReconciliationsSchema.createdAt, args.to));
  }
  const updated = await executor
    .update(transferReconciliationsSchema)
    .set({
      status: 'confirmed',
      arrivedAmount: sql`${transferReconciliationsSchema.expectedAmount}`,
      reconciledBy: args.reconciledBy,
      reconciledAt: new Date(),
    })
    .where(and(...conds))
    .returning({ id: transferReconciliationsSchema.id });
  return updated.length;
}
