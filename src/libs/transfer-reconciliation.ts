import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { findOpenSession, toMoney } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import {
  BLOCK_CLOSE_SETTING_KEY,
  DEFAULT_RESOLUTION_SETTING_KEY,
} from '@/libs/transfer-reconciliation-keys';
import { resolveBancoForMethod } from '@/libs/treasury';
import {
  appSettingsSchema,
  salePaymentsSchema,
  salesSchema,
  transferReconciliationsSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Methods whose money lands in a bank/wallet account (not the physical drawer)
// and therefore must be reconciled against the statement. Cash is the arqueo,
// handled by cash_movements. Tarjeta/datáfono settles through the acquirer on
// its own cycle and is intentionally OUT of scope for now. The credito credit
// portion is not money-in at all.
const CASH_TOKENS = ['efectivo', 'cash'];
const CARD_TOKENS = ['tarjeta', 'datafono', 'datáfono', 'card'];

export function methodNeedsReconciliation(method: string | null): boolean {
  const m = (method ?? '').trim().toLowerCase();
  if (!m) {
    return false;
  }
  if (/credito/.test(m)) {
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
  executor: Executor = db,
): Promise<void> {
  const [sale] = await executor
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

  const payments = await executor
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
    executor,
    sale.organizationId,
    sale.posTokenId,
  );

  await executor
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

// Creates ONE reconciliation row for a digital credito abono and returns its id so
// the covered credito_movements can link to it (via transfer_reconciliation_id,
// the digital twin of cash_movement_id). One real transfer = one row, even when
// the abono pays down several creditos. Runs INSIDE the abono transaction because
// the movements must link it; the insert is trivial so the rollback risk is low.
export async function createCreditoTransferReconciliation(
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

// Counts for the approval-inbox header: how many transfers are waiting, how many
// were confirmed since `confirmedSince` (the start of today), and how many never
// arrived (in investigation). One scan, FILTERed per status.
export async function countReconciliationsByStatus(
  executor: Executor,
  args: { organizationId: string; confirmedSince: Date },
): Promise<{ pending: number; confirmedToday: number; notArrived: number }> {
  const [row] = await executor
    .select({
      pending: sql<number>`COUNT(*) FILTER (WHERE ${transferReconciliationsSchema.status} = 'pending')::int`,
      confirmedToday: sql<number>`COUNT(*) FILTER (WHERE ${transferReconciliationsSchema.status} = 'confirmed' AND ${transferReconciliationsSchema.reconciledAt} >= ${args.confirmedSince})::int`,
      notArrived: sql<number>`COUNT(*) FILTER (WHERE ${transferReconciliationsSchema.status} = 'not_arrived')::int`,
    })
    .from(transferReconciliationsSchema)
    .where(eq(transferReconciliationsSchema.organizationId, args.organizationId));
  return {
    pending: Number(row?.pending ?? 0),
    confirmedToday: Number(row?.confirmedToday ?? 0),
    notArrived: Number(row?.notArrived ?? 0),
  };
}

// ── Pending-by-account grouping (cuadre-per-account redesign) ────────────────
// Sums PENDING transfer_reconciliations by the SAME banco account that
// depositConfirmedTransfer would credit on confirm. Reuses resolveBancoForMethod's
// EXACT join (payment_methods by lower(name), type='transfer', joined to its
// linked banco treasury_account) so the "what should be in each bank" preview
// never disagrees with where the money actually lands on confirm.
//
// A method that resolves to ZERO or MORE THAN ONE banco account is never
// silently dropped — its pending rows land in `unresolved` instead (broken
// down per method) so the owner still sees that money, even without a single
// account to attribute it to.
export type PendingByAccount = {
  accountId: string;
  total: number;
  count: number;
  // Raw method labels aggregated into this account — lets the caller filter
  // the underlying pending rows for a per-account "revisar una por una" view.
  methods: string[];
};

export type UnresolvedMethodBreakdown = {
  method: string;
  total: number;
  count: number;
};

export type UnresolvedPendingBucket = {
  total: number;
  count: number;
  methods: UnresolvedMethodBreakdown[];
};

export type PendingReconciliationsByAccount = {
  byAccount: PendingByAccount[];
  unresolved: UnresolvedPendingBucket;
};

export async function getPendingReconciliationsByAccount(
  executor: Executor,
  organizationId: string,
): Promise<PendingReconciliationsByAccount> {
  const methodTotals = await executor
    .select({
      method: transferReconciliationsSchema.method,
      total: sql<string>`COALESCE(SUM(${transferReconciliationsSchema.expectedAmount}), 0)::text`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(transferReconciliationsSchema)
    .where(
      and(
        eq(transferReconciliationsSchema.organizationId, organizationId),
        eq(transferReconciliationsSchema.status, 'pending'),
      ),
    )
    .groupBy(transferReconciliationsSchema.method);

  const byAccountMap = new Map<string, PendingByAccount>();
  const unresolvedMethods: UnresolvedMethodBreakdown[] = [];

  for (const row of methodTotals) {
    const total = Number.parseFloat(row.total) || 0;
    const count = Number(row.count) || 0;
    // Bounded by the org's distinct pending methods (typically a handful) —
    // one resolution per method, mirroring the exact join the real bank
    // deposit relies on (Slice E, treasury.ts).
    const accountId = await resolveBancoForMethod(executor, {
      organizationId,
      method: row.method,
    });
    if (accountId) {
      const existing = byAccountMap.get(accountId);
      byAccountMap.set(accountId, {
        accountId,
        total: Number.parseFloat(((existing?.total ?? 0) + total).toFixed(2)),
        count: (existing?.count ?? 0) + count,
        methods: [...(existing?.methods ?? []), row.method],
      });
    } else {
      unresolvedMethods.push({ method: row.method, total, count });
    }
  }

  const unresolvedTotal = unresolvedMethods.reduce((s, m) => s + m.total, 0);
  const unresolvedCount = unresolvedMethods.reduce((s, m) => s + m.count, 0);

  return {
    byAccount: Array.from(byAccountMap.values()),
    unresolved: {
      total: Number.parseFloat(unresolvedTotal.toFixed(2)),
      count: unresolvedCount,
      methods: unresolvedMethods,
    },
  };
}

// Resolves the PENDING reconciliation ids whose method maps to exactly the
// given banco account — powers the per-account "Confirmar las N" bulk
// confirm. Same resolution rule as above: a method that is ambiguous for the
// org as a whole (0 or 2+ banks) is never included, so a per-account confirm
// can never touch money that isn't unambiguously this account's.
export async function getPendingReconciliationIdsForAccount(
  executor: Executor,
  args: { organizationId: string; accountId: string },
): Promise<string[]> {
  const rows = await executor
    .select({
      id: transferReconciliationsSchema.id,
      method: transferReconciliationsSchema.method,
    })
    .from(transferReconciliationsSchema)
    .where(
      and(
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
        eq(transferReconciliationsSchema.status, 'pending'),
      ),
    );

  const resolutionCache = new Map<string, string | null>();
  const ids: string[] = [];
  for (const row of rows) {
    let resolved = resolutionCache.get(row.method);
    if (resolved === undefined) {
      resolved = await resolveBancoForMethod(executor, {
        organizationId: args.organizationId,
        method: row.method,
      });
      resolutionCache.set(row.method, resolved);
    }
    if (resolved === args.accountId) {
      ids.push(row.id);
    }
  }
  return ids;
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
// subset of ids). Returns the confirmed rows so the caller can bridge each one
// into a bank deposit (Slice E).
export async function bulkConfirmPending(
  executor: Executor,
  args: {
    organizationId: string;
    reconciledBy: string;
    ids?: string[];
    from?: Date;
    to?: Date;
  },
): Promise<TransferReconciliation[]> {
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
    .returning();
  return updated;
}

// ── Investigation + resolution (F3) ──────────────────────────────────────────
// A not_arrived transfer is NOT credit — it is a discrepancy to investigate. The
// cashier on duty explains the comprobante they confirmed; the owner then closes
// it with an outcome. 'receivable' (honest known customer -> credito) is the only
// outcome that needs orchestration (it touches the creditos ledger), so it lives in
// the action layer to avoid a creditos <-> reconciliation import cycle. The lib
// here only does the tenant-scoped reads and the status writes.

export type ResolutionType = NonNullable<TransferReconciliation['resolutionType']>;

// expected - arrived. For not_arrived (arrived null) this is the full amount; for
// a mismatch it is the shortfall.
export function outstandingAmount(
  row: Pick<TransferReconciliation, 'expectedAmount' | 'arrivedAmount'>,
): number {
  const expected = Number.parseFloat(row.expectedAmount) || 0;
  const arrived
    = row.arrivedAmount != null ? Number.parseFloat(row.arrivedAmount) || 0 : 0;
  return Number.parseFloat((expected - arrived).toFixed(2));
}

export async function getReconciliationById(
  executor: Executor,
  args: { id: string; organizationId: string },
): Promise<TransferReconciliation | null> {
  const [row] = await executor
    .select()
    .from(transferReconciliationsSchema)
    .where(
      and(
        eq(transferReconciliationsSchema.id, args.id),
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Resolves the originating sale + its customer notes for a sale-sourced row, so
// the action can decide whether 'receivable' (credito) is even possible.
export async function getReconciliationSale(
  executor: Executor,
  salePaymentId: string,
): Promise<{ saleId: string; notes: string | null } | null> {
  const [row] = await executor
    .select({ saleId: salesSchema.id, notes: salesSchema.notes })
    .from(salePaymentsSchema)
    .innerJoin(salesSchema, eq(salesSchema.id, salePaymentsSchema.saleId))
    .where(eq(salePaymentsSchema.id, salePaymentId))
    .limit(1);
  return row ?? null;
}

// Closes the investigation with an outcome. The credito for 'receivable' is created
// by the caller (action layer) and passed in as resolutionCreditoId.
// `status` MUST be supplied by the action layer: 'resolved' for all loss/credito/
// cashier-liability paths; 'confirmed' for late-arrival (reuses confirmReconciliation).
// `claimOpen` is only set for PÉRDIDA+RECLAMO (loss + active claim).
export async function setReconciliationResolution(
  executor: Executor,
  args: {
    id: string;
    organizationId: string;
    resolutionType: ResolutionType;
    resolvedBy: string;
    status: 'resolved' | 'confirmed';
    resolutionCreditoId?: string | null;
    claimOpen?: boolean;
  },
): Promise<TransferReconciliation | null> {
  const [row] = await executor
    .update(transferReconciliationsSchema)
    .set({
      status: args.status,
      resolutionType: args.resolutionType,
      resolvedBy: args.resolvedBy,
      resolvedAt: new Date(),
      resolutionCreditoId: args.resolutionCreditoId ?? null,
      claimOpen: args.claimOpen ?? false,
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

// ── Axis-1: Partial arrival split (F4) ───────────────────────────────────────
// When a not_arrived transfer partially shows up, we split it into two rows:
//   • original → resolved, arrivedAmount=$X, remainderReconciliationId set
//   • new      → not_arrived, expectedAmount=original.expected-$X
// Conservation law: arrived + remainder.expected === original.expected.
// Validation: 0 < arrivedAmount < expectedAmount (strict bounds — equals = full).
// Must run inside a transaction; returns both rows for the action layer to
// post the treasury credit and build the response.

export type PartialArrivalResult = {
  original: TransferReconciliation;
  remainder: TransferReconciliation;
};

export async function splitPartialArrival(
  executor: Executor,
  args: {
    id: string;
    organizationId: string;
    reconciledBy: string;
    arrivedAmount: number | string;
  },
): Promise<PartialArrivalResult> {
  // Re-read inside the executor so callers can use this in a transaction.
  const original = await getReconciliationById(executor, {
    id: args.id,
    organizationId: args.organizationId,
  });

  if (!original) {
    throw new Error('Transferencia no encontrada o no pertenece a esta organización');
  }

  // Current-status guard: a partial arrival applies to a row that is still open
  // — `pending` (straight from the Novedad flow at verification time) or already
  // under investigation (`not_arrived` / `mismatch`). A terminal `resolved` row
  // (replay) or an already-`confirmed` row must never be re-split — that would
  // create a second live remainder or post a credit for money already booked.
  if (
    original.status !== 'pending'
    && original.status !== 'not_arrived'
    && original.status !== 'mismatch'
  ) {
    throw new Error(
      original.status === 'resolved'
        ? 'Esta transferencia ya fue resuelta'
        : 'Solo se puede registrar un arribo parcial de una transferencia abierta',
    );
  }

  const expected = Number.parseFloat(original.expectedAmount) || 0;
  const arrived = Number.parseFloat(String(args.arrivedAmount));

  // Strict bounds: must be > 0 and strictly < expected.
  if (!Number.isFinite(arrived) || arrived <= 0 || arrived >= expected) {
    throw new Error(
      `El monto recibido debe ser mayor a 0 y menor a ${expected} (el esperado). `
      + `Para registrar un arribo completo usá "llegó tarde completa".`,
    );
  }

  // Conservation law: remainder = expected - arrived, rounded to 2 decimal places.
  const remainder = Number.parseFloat(
    (expected - arrived).toFixed(2),
  );

  // 1. Close the original row as resolved with the partial arrived amount.
  //    The original RELEASES its sale_payment_id (set null): the LIVE
  //    not_arrived remainder will carry it instead, so the partial UNIQUE index
  //    `transfer_reconciliations_sale_payment_idx` (one ACTIVE reconciliation
  //    per sale_payment) is never violated. The deposit for the arrived $X is
  //    keyed by THIS row's id (not sale_payment_id), so releasing it does NOT
  //    break the treasury credit. The original→remainder link below keeps the
  //    audit chain back to the sale.
  const [updatedOriginal] = await executor
    .update(transferReconciliationsSchema)
    .set({
      status: 'resolved',
      arrivedAmount: toMoney(arrived),
      salePaymentId: null,
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

  if (!updatedOriginal) {
    throw new Error('No se pudo actualizar la transferencia original');
  }

  // 2. Insert the remainder row. Inherits org, method, and salePaymentId from
  //    the original — the remainder is now the SINGLE live row holding that
  //    sale_payment_id, so backfill idempotency holds and a later CREDITO
  //    resolution can still resolve the sale via getReconciliationSale. No
  //    resolution fields (claimOpen stays false by default, recoveryOfId null).
  const [remainderRow] = await executor
    .insert(transferReconciliationsSchema)
    .values({
      organizationId: original.organizationId,
      salePaymentId: original.salePaymentId ?? null,
      posTokenId: original.posTokenId ?? null,
      cashSessionId: original.cashSessionId ?? null,
      method: original.method,
      expectedAmount: toMoney(remainder),
      reference: original.reference ?? null,
      status: 'not_arrived',
    })
    .returning();

  if (!remainderRow) {
    throw new Error('No se pudo crear la fila de saldo pendiente');
  }

  // 3. Link original → remainder via remainderReconciliationId.
  const [linked] = await executor
    .update(transferReconciliationsSchema)
    .set({ remainderReconciliationId: remainderRow.id })
    .where(eq(transferReconciliationsSchema.id, updatedOriginal.id))
    .returning();

  if (!linked) {
    throw new Error('No se pudo enlazar el remanente');
  }

  return { original: linked, remainder: remainderRow };
}

// ── Reclassification support (F5) ────────────────────────────────────────────
// When a reclassification moves money INTO a transfer method it creates a row
// for the new sale payment; when it reduces a transfer payment it syncs that
// payment's pending reconciliation. Executor-aware so the reclassification can
// run inside its transaction.

export async function createReconciliationForPayment(
  executor: Executor,
  args: {
    organizationId: string;
    salePaymentId: string;
    method: string;
    expectedAmount: number | string;
    posTokenId?: string | null;
    cashSessionId?: string | null;
    reference?: string | null;
  },
): Promise<void> {
  await executor
    .insert(transferReconciliationsSchema)
    .values({
      organizationId: args.organizationId,
      salePaymentId: args.salePaymentId,
      method: args.method,
      expectedAmount: toMoney(args.expectedAmount),
      posTokenId: args.posTokenId ?? null,
      cashSessionId: args.cashSessionId ?? null,
      reference: args.reference ?? null,
    })
    .onConflictDoNothing();
}

// Adjusts the expected amount of a sale payment's PENDING reconciliation (a
// reclassification reduced the transfer). Confirmed/resolved rows are left
// untouched — you do not silently change a transfer the owner already reconciled.
export async function syncPendingReconciliationAmount(
  executor: Executor,
  args: {
    salePaymentId: string;
    organizationId: string;
    expectedAmount: number | string;
  },
): Promise<void> {
  await executor
    .update(transferReconciliationsSchema)
    .set({ expectedAmount: toMoney(args.expectedAmount) })
    .where(
      and(
        eq(transferReconciliationsSchema.salePaymentId, args.salePaymentId),
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
        eq(transferReconciliationsSchema.status, 'pending'),
      ),
    );
}

// ── Axis-2: Cross-period recovery (ADR-8) ────────────────────────────────────
// When money reappears after a closed-period loss, the admin creates a RECOVERY:
// a NEW transfer_reconciliations row in the CURRENT period that references the
// old loss row via recoveryOfId. The old row is NEVER modified (immutability).
//
// Invariants enforced:
//   • recoveryOfId MUST reference a row with resolution_type='loss'. Any other
//     row (cashier_liability, receivable, not_arrived, confirmed) is rejected.
//   • The new row status=confirmed + recoveryOfId set. No resolution_type on it
//     (recovery is a new credit event, not a resolution outcome).
//   • resolutionType is intentionally null on the recovery row.
//
// The caller (action layer) is responsible for posting the treasury credit after
// this function returns (depositConfirmedTransfer), following the same best-effort
// pattern as confirmTransfer. MUST run inside the caller's transaction.
export async function createRecoveryReconciliation(
  executor: Executor,
  args: {
    organizationId: string;
    recoveryOfId: string;
    method: string;
    amount: number | string;
    createdBy: string;
  },
): Promise<TransferReconciliation> {
  // Guard: only loss rows can be recovered (S-22 invariant). Scope by
  // organizationId too (defense-in-depth, S-14): a loss row from another org
  // must never be a valid recovery source even if the id is guessed/replayed.
  const [sourceRow] = await executor
    .select({
      id: transferReconciliationsSchema.id,
      resolutionType: transferReconciliationsSchema.resolutionType,
      status: transferReconciliationsSchema.status,
    })
    .from(transferReconciliationsSchema)
    .where(
      and(
        eq(transferReconciliationsSchema.id, args.recoveryOfId),
        eq(transferReconciliationsSchema.organizationId, args.organizationId),
      ),
    )
    .limit(1);

  if (!sourceRow) {
    throw new Error(
      'La transferencia original no fue encontrada. Solo se puede recuperar una transferencia marcada como pérdida.',
    );
  }

  if (sourceRow.resolutionType !== 'loss') {
    throw new Error(
      `Solo se puede crear una recuperación para una PÉRDIDA. La transferencia seleccionada tiene tipo '${sourceRow.resolutionType ?? sourceRow.status}', no 'loss'.`,
    );
  }

  // Insert recovery row: status=confirmed, recoveryOfId set, no resolutionType.
  const [newRow] = await executor
    .insert(transferReconciliationsSchema)
    .values({
      organizationId: args.organizationId,
      method: args.method,
      expectedAmount: toMoney(args.amount),
      arrivedAmount: toMoney(args.amount),
      status: 'confirmed',
      recoveryOfId: args.recoveryOfId,
      reconciledBy: args.createdBy,
      reconciledAt: new Date(),
    })
    .returning();

  if (!newRow) {
    throw new Error('No se pudo insertar la fila de recuperación');
  }

  return newRow;
}

// ── Org toggle helpers (PR6) ─────────────────────────────────────────────────
//
// Two org-level admin-only toggles are stored in `app_settings`:
//
// (A) transfer-block-close-on-investigation (bool, default false)
//     When ON: the POS and panel close paths reject if any not_arrived row
//     exists for the org. The shared hasOpenInvestigations helper is used by
//     both surfaces so they always agree.
//
// (B) transfer-default-resolution (enum 'investigate'|'direct_loss', default 'investigate')
//     When 'direct_loss': markTransferNotArrived auto-resolves the row as a
//     loss instead of parking it in not_arrived. The admin pre-consented via
//     this setting, so the interactive admin gate is intentionally bypassed.
//     See ADR-5 in design obs #277.
//
// Both helpers are executor-aware so they can run inside transactions.

// Setting keys live in the client-safe ./transfer-reconciliation-keys module so
// client components can import them without pulling this server-only module
// (DB + Clerk auth) into the browser bundle. Re-exported here so existing
// server-side importers keep working unchanged.
export { BLOCK_CLOSE_SETTING_KEY, DEFAULT_RESOLUTION_SETTING_KEY };

/**
 * Returns true if at least one `not_arrived` row exists for the org.
 * Cheap SELECT 1 ... LIMIT 1 — safe inside a transaction.
 */
export async function hasOpenInvestigations(
  executor: Executor,
  organizationId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ one: sql<number>`1` })
    .from(transferReconciliationsSchema)
    .where(
      and(
        eq(transferReconciliationsSchema.organizationId, organizationId),
        eq(transferReconciliationsSchema.status, 'not_arrived'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Returns true when toggle A is explicitly set to 'true' for the org.
 * Default (absent or empty) is false.
 */
export async function getBlockCloseOnInvestigation(
  executor: Executor,
  organizationId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        eq(appSettingsSchema.key, BLOCK_CLOSE_SETTING_KEY),
      ),
    )
    .limit(1);
  return (row?.value ?? '') === 'true';
}

/**
 * Returns the default resolution mode for toggle B.
 * Default (absent or empty or 'investigate') is 'investigate'.
 */
export async function getDefaultResolution(
  executor: Executor,
  organizationId: string,
): Promise<'investigate' | 'direct_loss'> {
  const [row] = await executor
    .select({ value: appSettingsSchema.value })
    .from(appSettingsSchema)
    .where(
      and(
        eq(appSettingsSchema.organizationId, organizationId),
        eq(appSettingsSchema.key, DEFAULT_RESOLUTION_SETTING_KEY),
      ),
    )
    .limit(1);
  const v = row?.value ?? '';
  return v === 'direct_loss' ? 'direct_loss' : 'investigate';
}
