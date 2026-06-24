import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { round2 } from '@/libs/creditos-math';
import { recordSupplierPaymentOutflow } from '@/libs/treasury';
import {
  cashMovementsSchema,
  supplierPayablesSchema,
  supplierPaymentsSchema,
  supplierPurchasesSchema,
  suppliersSchema,
} from '@/models/Schema';

// Executor is typed as `any` to bridge Drizzle db/tx/TenantDb (same pattern as
// supplier-payables.ts). All exported function signatures are explicit.
// biome-ignore lint/suspicious/noExplicitAny: bridges Drizzle db/tx/TenantDb structural mismatch
type Executor = any;

// ── recordInvoicePayment ──────────────────────────────────────────────────────

export type RecordInvoicePaymentInput = {
  organizationId: string;
  purchaseId: string;
  fromAccountId: string;
  amount: number;
  createdBy: string;
  note?: string | null;
};

export type InvoicePaymentBreakdown = {
  payableId: string;
  chunk: number;
  payableStatus: 'open' | 'partial' | 'paid';
};

export type RecordInvoicePaymentResult = {
  appliedTotal: number;
  breakdown: InvoicePaymentBreakdown[];
};

/**
 * Pays a supplier purchase invoice as a unit, allocating the amount across its
 * open/partial payable lines in OLDEST-FIRST order (purchased_at ASC, id ASC).
 *
 * Architecture:
 *   - Opens ONE outer db.transaction (all-or-nothing for the invoice).
 *   - Reads the invoice's open/partial payables WITHOUT locking them (unlocked
 *     read for allocation sizing). Computing the allocation unlocked is safe: if
 *     a concurrent payment shrank a payable's outstanding between the read and
 *     the helper call, the helper's per-payable cap (FOR UPDATE + outstanding
 *     check inside recordSupplierPaymentOutflow) rejects and the whole outer tx
 *     rolls back — acceptable.
 *   - For each payable in oldest-first order, calls the EXISTING
 *     recordSupplierPaymentOutflow(tx, {payableId, chunk, …}) helper, which:
 *       1. Acquires the container lock (treasury_accounts FOR UPDATE).
 *       2. Checks balance.
 *       3. Acquires the payable lock (supplier_payables FOR UPDATE).
 *       4. Writes one salida treasury_movements row.
 *       5. Writes one supplier_payments row.
 *       6. Updates supplier_payables.paid_amount + status.
 *
 * DEADLOCK-CRITICAL — lock order:
 *   Global order: treasury_accounts → supplier_payables.
 *   recordSupplierPaymentOutflow locks the CONTAINER first (lockAccountsForUpdate),
 *   then the payable. Because ALL chunks in a single invoice payment debit the
 *   SAME fromAccountId and payables are processed in a deterministic oldest-first
 *   order, no opposite-order acquisition is possible, so no cycle can form.
 *   We do NOT pre-lock payables before the container. Any concurrent payment on
 *   the same payable will serialize on the container lock — the second tx will
 *   either proceed after the first commits (balance already debited) or fail with
 *   "saldo insuficiente" (balance insufficient). Both outcomes are safe.
 *
 * Amount cap:
 *   amount is validated against SUM(line outstanding) BEFORE opening the tx.
 *   Excess is rejected with a clear error; no partial treasury debit is written.
 *
 * KPI correctness:
 *   paidThisMonth = SUM(supplier_payments.amount) — preserved because each chunk
 *   gets its own supplier_payments row (one per payable per payment event).
 *   No single salida splits across payables, matching the existing KPI path.
 */
export async function recordInvoicePayment(
  executor: Executor,
  input: RecordInvoicePaymentInput,
): Promise<RecordInvoicePaymentResult> {
  const requestedAmt = round2(input.amount);

  if (requestedAmt <= 0) {
    throw new Error('amount must be greater than zero');
  }

  // ── 1. Load open/partial payables for this invoice (unlocked read) ────────
  // ORDER BY purchased_at ASC, id ASC → deterministic oldest-first.
  // We read WITHOUT FOR UPDATE here (see lock-order note above).
  const payables = await executor
    .select({
      id: supplierPayablesSchema.id,
      supplierId: supplierPayablesSchema.supplierId,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
    })
    .from(supplierPayablesSchema)
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, input.organizationId),
        eq(supplierPayablesSchema.purchaseId, input.purchaseId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(
      asc(supplierPayablesSchema.purchasedAt),
      asc(supplierPayablesSchema.id),
    );

  if (payables.length === 0) {
    throw new Error(
      `invoice ${input.purchaseId} has no open or partial payables`,
    );
  }

  // ── 2. Compute allocation (oldest-first, each chunk capped at line outstanding) ─
  type Allocation = { payableId: string; supplierId: string; chunk: number };
  const allocations: Allocation[] = [];
  let remaining = requestedAmt;

  for (const p of payables) {
    if (remaining <= 0) {
      break;
    }
    const total = round2(Number.parseFloat(p.totalAmount));
    const paid = round2(Number.parseFloat(p.paidAmount));
    const credited = round2(Number.parseFloat(p.creditedAmount ?? '0'));
    const outstanding = round2(total - paid - credited);
    if (outstanding <= 0) {
      continue;
    }
    const chunk = round2(Math.min(remaining, outstanding));
    allocations.push({ payableId: p.id, supplierId: p.supplierId, chunk });
    remaining = round2(remaining - chunk);
  }

  const appliedTotal = round2(requestedAmt - remaining);

  // ── 3. Validate: amount must not exceed invoice outstanding ───────────────
  // If there is still unallocated amount after consuming all lines, the caller
  // tried to overpay. remaining > 0 means the requested amount > SUM(outstanding).
  if (remaining > 0.005) {
    throw new Error(
      `exceeds invoice outstanding: requested ${requestedAmt.toFixed(2)}, `
      + `invoice outstanding ${appliedTotal.toFixed(2)}`,
    );
  }

  // ── 4. Execute all chunks inside ONE outer transaction ────────────────────
  // Each call to recordSupplierPaymentOutflow receives the TX object (not the
  // top-level db), so it skips its own transaction wrapper (isRealDb = false)
  // and runs directly inside our outer tx. All-or-nothing for the invoice.
  const doWork = async (tx: Executor): Promise<RecordInvoicePaymentResult> => {
    const breakdown: InvoicePaymentBreakdown[] = [];

    for (const alloc of allocations) {
      const chunkResult = await recordSupplierPaymentOutflow(tx, {
        organizationId: input.organizationId,
        fromAccountId: input.fromAccountId,
        amount: alloc.chunk,
        supplierId: alloc.supplierId,
        payableId: alloc.payableId,
        note: input.note ?? null,
        createdBy: input.createdBy,
      });
      breakdown.push({
        payableId: alloc.payableId,
        chunk: alloc.chunk,
        payableStatus: chunkResult.payableStatus,
      });
    }

    return { appliedTotal, breakdown };
  };

  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as { transaction: <T>(cb: (tx: Executor) => Promise<T>) => Promise<T> })
      .transaction(tx => doWork(tx));
  }
  return doWork(executor);
}

// ── listOpenInvoices ──────────────────────────────────────────────────────────

export type OpenInvoiceGroup = {
  /** Null for standalone payables (no invoice header). */
  purchaseId: string | null;
  /**
   * For standalone groups (purchaseId = null): the exact payable id so the UI
   * can open the payment modal for the correct row without a secondary `.find`.
   * Null for invoice groups.
   */
  standalonePayableId: string | null;
  invoiceNumber: string | null;
  supplierId: string;
  supplierName: string | null;
  purchasedAt: Date | null;
  lineCount: number;
  totalAmount: string;
  outstanding: string;
  status: 'open' | 'partial';
};

/**
 * Groups open/partial payables by their invoice header (purchase_id).
 *
 * Standalone payables (purchase_id = null) surface as single-line groups so
 * nothing disappears — regression-critical (D1: back-compat for existing data).
 *
 * Aggregates per group:
 *   - lineCount:    number of open/partial lines in this group
 *   - totalAmount:  SUM(total_amount) — gross value of all open/partial lines
 *   - outstanding:  SUM(total_amount - paid_amount - credited_amount)
 *   - status:       'open' when all lines are open; 'partial' when any is partial
 *
 * Ordering: most recent purchasedAt first (invoice date DESC for invoices,
 * payable purchased_at DESC for standalone).
 */
export async function listOpenInvoices(
  executor: Executor,
  organizationId: string,
): Promise<OpenInvoiceGroup[]> {
  // Fetch open/partial payables with their optional invoice header.
  const rows = await executor
    .select({
      id: supplierPayablesSchema.id,
      supplierId: supplierPayablesSchema.supplierId,
      purchaseId: supplierPayablesSchema.purchaseId,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
      status: supplierPayablesSchema.status,
      purchasedAt: supplierPayablesSchema.purchasedAt,
      // Invoice header fields (null for standalone)
      invoiceNumber: supplierPurchasesSchema.invoiceNumber,
      invoicePurchasedAt: supplierPurchasesSchema.purchasedAt,
      supplierName: suppliersSchema.name,
    })
    .from(supplierPayablesSchema)
    .leftJoin(
      supplierPurchasesSchema,
      eq(supplierPurchasesSchema.id, supplierPayablesSchema.purchaseId),
    )
    .leftJoin(
      suppliersSchema,
      sql`${suppliersSchema.id}::text = ${supplierPayablesSchema.supplierId}`,
    )
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, organizationId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(
      asc(supplierPayablesSchema.purchasedAt),
      asc(supplierPayablesSchema.id),
    );

  // Group by purchase_id (null = standalone; each gets its own group key).
  // We use a Map where key = purchaseId or a unique per-payable sentinel for nulls.
  type GroupAcc = {
    purchaseId: string | null;
    /** Populated only for standalone groups (purchaseId = null). */
    standalonePayableId: string | null;
    invoiceNumber: string | null;
    supplierId: string;
    supplierName: string | null;
    purchasedAt: Date | null;
    lines: Array<{
      totalAmount: number;
      outstanding: number;
      status: 'open' | 'partial';
    }>;
  };

  const groupMap = new Map<string, GroupAcc>();

  for (const r of rows) {
    const total = round2(Number.parseFloat(r.totalAmount));
    const paid = round2(Number.parseFloat(r.paidAmount));
    const credited = round2(Number.parseFloat(r.creditedAmount ?? '0'));
    const outstanding = round2(total - paid - credited);

    // For standalone payables, each payable is its own group keyed by its id.
    const groupKey = r.purchaseId ?? `standalone:${r.id}`;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        purchaseId: r.purchaseId ?? null,
        // For standalone groups, record the exact payable id for direct UI targeting.
        standalonePayableId: r.purchaseId == null ? r.id : null,
        invoiceNumber: r.invoiceNumber ?? null,
        supplierId: r.supplierId,
        supplierName: r.supplierName ?? null,
        purchasedAt: r.invoicePurchasedAt ?? r.purchasedAt ?? null,
        lines: [],
      });
    }
    groupMap.get(groupKey)!.lines.push({
      totalAmount: total,
      outstanding,
      status: r.status as 'open' | 'partial',
    });
  }

  // Aggregate and sort newest-first.
  const result: OpenInvoiceGroup[] = [];

  for (const group of groupMap.values()) {
    const lineCount = group.lines.length;
    const totalAmount = round2(
      group.lines.reduce((s, l) => s + l.totalAmount, 0),
    );
    const totalOutstanding = round2(
      group.lines.reduce((s, l) => s + l.outstanding, 0),
    );
    // Status: partial if any line is partial; open otherwise.
    const status: 'open' | 'partial' = group.lines.some(l => l.status === 'partial')
      ? 'partial'
      : 'open';

    result.push({
      purchaseId: group.purchaseId,
      standalonePayableId: group.standalonePayableId,
      invoiceNumber: group.invoiceNumber,
      supplierId: group.supplierId,
      supplierName: group.supplierName,
      purchasedAt: group.purchasedAt,
      lineCount,
      totalAmount: totalAmount.toFixed(2),
      outstanding: totalOutstanding.toFixed(2),
      status,
    });
  }

  // Sort newest-first by purchasedAt.
  result.sort((a, b) => {
    const tA = a.purchasedAt?.getTime() ?? 0;
    const tB = b.purchasedAt?.getTime() ?? 0;
    return tB - tA;
  });

  return result;
}

// ── createOrGetInvoice ────────────────────────────────────────────────────────
// Creates a new supplier_purchases header or returns an existing open one.
// Called from recordMovement when the user picks "add to existing invoice"
// or "new invoice" in the EntryModal.

export type InvoiceContext
  = | { mode: 'new'; invoiceNumber?: string | null; notes?: string | null }
    | { mode: 'existing'; purchaseId: string };

export type ResolvedInvoice = {
  purchaseId: string;
  created: boolean;
};

/**
 * Resolves the invoice header inside an existing transaction.
 *
 * - mode 'existing': verifies the purchase belongs to org+supplier, returns it.
 * - mode 'new': inserts a new supplier_purchases row, returns its id.
 *
 * Must be called INSIDE the parent tx so it's part of the same commit.
 */
export async function resolveInvoiceInTx(
  tx: Executor,
  input: {
    organizationId: string;
    supplierId: string;
    createdBy: string;
    context: InvoiceContext;
  },
): Promise<ResolvedInvoice> {
  if (input.context.mode === 'existing') {
    const [purchase] = await tx
      .select({
        id: supplierPurchasesSchema.id,
        organizationId: supplierPurchasesSchema.organizationId,
        supplierId: supplierPurchasesSchema.supplierId,
      })
      .from(supplierPurchasesSchema)
      .where(
        and(
          eq(supplierPurchasesSchema.id, input.context.purchaseId),
          eq(supplierPurchasesSchema.organizationId, input.organizationId),
        ),
      )
      .limit(1);

    if (!purchase) {
      throw new Error(
        `invoice ${input.context.purchaseId} not found for this organization`,
      );
    }
    if (purchase.supplierId !== input.supplierId) {
      throw new Error('invoice supplier does not match current entry supplier');
    }

    return { purchaseId: purchase.id, created: false };
  }

  // mode === 'new'
  const [created] = await tx
    .insert(supplierPurchasesSchema)
    .values({
      organizationId: input.organizationId,
      supplierId: input.supplierId,
      invoiceNumber: input.context.invoiceNumber ?? null,
      notes: input.context.notes ?? null,
      createdBy: input.createdBy,
    })
    .returning({ id: supplierPurchasesSchema.id });

  if (!created) {
    throw new Error('Failed to create supplier_purchases row');
  }

  return { purchaseId: created.id, created: true };
}

// ── listOpenInvoicesForSupplier ───────────────────────────────────────────────
// Used by the EntryModal to offer "add to existing open invoice" for this supplier.

export type InvoiceOption = {
  id: string;
  invoiceNumber: string | null;
  purchasedAt: Date;
  lineCount: number;
};

export async function listOpenInvoicesForSupplier(
  executor: Executor,
  organizationId: string,
  supplierId: string,
): Promise<InvoiceOption[]> {
  // Get purchase_ids that still have open/partial payables for this supplier.
  const openPayables = await executor
    .select({ purchaseId: supplierPayablesSchema.purchaseId })
    .from(supplierPayablesSchema)
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, organizationId),
        eq(supplierPayablesSchema.supplierId, supplierId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
        isNotNull(supplierPayablesSchema.purchaseId),
      ),
    );

  const openIds = openPayables
    .map((r: { purchaseId: string | null }) => r.purchaseId)
    .filter(Boolean) as string[];

  if (openIds.length === 0) {
    return [];
  }

  const purchases = await executor
    .select({
      id: supplierPurchasesSchema.id,
      invoiceNumber: supplierPurchasesSchema.invoiceNumber,
      purchasedAt: supplierPurchasesSchema.purchasedAt,
    })
    .from(supplierPurchasesSchema)
    .where(
      and(
        eq(supplierPurchasesSchema.organizationId, organizationId),
        inArray(supplierPurchasesSchema.id, openIds),
      ),
    )
    .orderBy(asc(supplierPurchasesSchema.purchasedAt));

  // Count lines per purchase from the payables we already fetched.
  const countMap = new Map<string, number>();
  for (const p of openPayables) {
    if (p.purchaseId) {
      countMap.set(p.purchaseId, (countMap.get(p.purchaseId) ?? 0) + 1);
    }
  }

  return purchases.map((p: { id: string; invoiceNumber: string | null; purchasedAt: Date }) => ({
    id: p.id,
    invoiceNumber: p.invoiceNumber,
    purchasedAt: p.purchasedAt,
    lineCount: countMap.get(p.id) ?? 0,
  }));
}

// ── getSupplierOutstanding ────────────────────────────────────────────────────
// Returns the total amount owed to a supplier across ALL open/partial payables.
// Used by: POS route (settle-vs-gasto decision), read endpoint, recordSupplierPayment.
// Read-only; no lock acquired.

export type SupplierOutstandingResult = {
  totalOutstanding: number;
  invoiceCount: number;
  invoices: Array<{
    payableId: string;
    purchasedAt: Date;
    outstanding: number;
    status: 'open' | 'partial';
    invoiceNumber: string | null;
  }>;
};

export async function getSupplierOutstanding(
  executor: Executor,
  organizationId: string,
  supplierId: string,
): Promise<SupplierOutstandingResult> {
  const rows = await executor
    .select({
      id: supplierPayablesSchema.id,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
      status: supplierPayablesSchema.status,
      purchasedAt: supplierPayablesSchema.purchasedAt,
      invoiceNumber: supplierPurchasesSchema.invoiceNumber,
    })
    .from(supplierPayablesSchema)
    .leftJoin(
      supplierPurchasesSchema,
      eq(supplierPayablesSchema.purchaseId, supplierPurchasesSchema.id),
    )
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, organizationId),
        eq(supplierPayablesSchema.supplierId, supplierId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(
      asc(supplierPayablesSchema.purchasedAt),
      asc(supplierPayablesSchema.id),
    );

  const invoices: SupplierOutstandingResult['invoices'] = rows.map((r: {
    id: string;
    totalAmount: string;
    paidAmount: string;
    creditedAmount: string | null;
    status: 'open' | 'partial';
    purchasedAt: Date;
    invoiceNumber: string | null;
  }) => {
    const total = round2(Number.parseFloat(r.totalAmount));
    const paid = round2(Number.parseFloat(r.paidAmount));
    const credited = round2(Number.parseFloat(r.creditedAmount ?? '0'));
    return {
      payableId: r.id,
      purchasedAt: r.purchasedAt,
      outstanding: round2(total - paid - credited),
      status: r.status,
      invoiceNumber: r.invoiceNumber ?? null,
    };
  });

  const totalOutstanding = round2(invoices.reduce((s, i) => s + i.outstanding, 0));

  return { totalOutstanding, invoiceCount: invoices.length, invoices };
}

// ── recordCajaPayableSettle ───────────────────────────────────────────────────
// Inline caja-funded settle for ONE payable chunk.
// Called from recordSupplierPayment when fundingSource.kind === 'caja'.
//
// Writes (inside caller's tx):
//   1. cash_movements (type='expense', expense_id=NULL, supplier_id set) — the
//      physical cash exits the drawer exactly like any other expense; the arqueo
//      filter (type IN ('expense',...)) counts it identically to a gasto.
//   2. supplier_payments (cash_movement_id=<#1.id>, treasury_movement_id=NULL).
//   3. UPDATE supplier_payables (paid_amount += chunk, status recomputed).
//
// Does NOT write: expenses (no P&L), treasury_movements (no container debit).
// Lock: SELECT ... FOR UPDATE on the payable row ONLY (oldest-first by caller).
// OQ-2 fix: expense_id=NULL lets getTodayCashKpis narrow gastos_hoy to
//           type='expense' AND expense_id IS NOT NULL without counting this row.

type CajaPayableSettleInput = {
  organizationId: string;
  sessionId: string;
  payableId: string;
  supplierId: string;
  amount: number; // already round2'd by caller
  note?: string | null;
  createdBy: string;
};

type CajaPayableSettleResult = {
  cashMovementId: string;
  payableStatus: 'open' | 'partial' | 'paid';
};

export async function recordCajaPayableSettle(
  tx: Executor,
  input: CajaPayableSettleInput,
): Promise<CajaPayableSettleResult> {
  // 1. Lock the payable row FOR UPDATE (oldest-first guaranteed by caller).
  const [payable] = await tx
    .select({
      id: supplierPayablesSchema.id,
      organizationId: supplierPayablesSchema.organizationId,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
      status: supplierPayablesSchema.status,
    })
    .from(supplierPayablesSchema)
    .where(eq(supplierPayablesSchema.id, input.payableId))
    .for('update')
    .limit(1);

  if (!payable) {
    throw new Error(`payable not found: ${input.payableId}`);
  }
  if (payable.organizationId !== input.organizationId) {
    throw new Error('payable does not belong to this organization');
  }
  if (payable.status === 'paid') {
    throw new Error('payable already paid — no additional payments accepted');
  }

  const totalAmt = round2(Number.parseFloat(payable.totalAmount));
  const alreadyPaid = round2(Number.parseFloat(payable.paidAmount));
  const credited = round2(Number.parseFloat(payable.creditedAmount ?? '0'));
  const outstanding = round2(totalAmt - alreadyPaid - credited);

  if (input.amount > outstanding + 0.005) {
    throw new Error(
      `chunk (${input.amount.toFixed(2)}) exceeds payable outstanding (${outstanding.toFixed(2)})`,
    );
  }

  // 2. Insert ONE cash_movements row — type='expense', expense_id=NULL (no P&L anchor).
  //    cash leaves the physical drawer; arqueo salidas filter keys on type only.
  const [movRow] = await tx
    .insert(cashMovementsSchema)
    .values({
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      type: 'expense',
      amount: input.amount.toFixed(2),
      reason: input.note ?? 'Pago a proveedor',
      supplierId: input.supplierId,
      expenseId: null, // NOT a P&L gasto — intentionally no anchor
      createdBy: input.createdBy,
    })
    .returning({ id: cashMovementsSchema.id });

  if (!movRow) {
    throw new Error('recordCajaPayableSettle: cash_movements insert returned no row');
  }

  // 3. Insert supplier_payments — cash_movement_id set, treasury_movement_id NULL.
  await tx
    .insert(supplierPaymentsSchema)
    .values({
      organizationId: input.organizationId,
      supplierId: input.supplierId,
      payableId: input.payableId,
      cashMovementId: movRow.id,
      treasuryMovementId: null,
      amount: input.amount.toFixed(2),
      note: input.note ?? null,
      createdBy: input.createdBy,
    });

  // 4. Update payable: paid_amount += chunk, recompute status.
  const newPaid = round2(alreadyPaid + input.amount);
  const newStatus: 'open' | 'partial' | 'paid'
    = newPaid + credited >= totalAmt - 0.005 ? 'paid' : newPaid > 0 ? 'partial' : 'open';

  await tx
    .update(supplierPayablesSchema)
    .set({
      paidAmount: newPaid.toFixed(2),
      status: newStatus,
    })
    .where(eq(supplierPayablesSchema.id, input.payableId));

  return { cashMovementId: movRow.id, payableStatus: newStatus };
}

// ── recordSupplierPayment ─────────────────────────────────────────────────────
// Unified supplier-payment primitive — allocates across ALL open/partial payables
// for a supplier (oldest-first) from ONE funding source.
//
// fundingSource:
//   { kind: 'treasury', accountId } → recordSupplierPaymentOutflow per chunk.
//   { kind: 'caja',     sessionId } → recordCajaPayableSettle per chunk.
//
// Returns: { appliedTotal, excess, breakdown }.
// excess > 0 means the amount exceeded total outstanding; caller decides UX.
// Does NOT fabricate credits. Does NOT overpay payables.

export type SupplierPaymentFundingSource
  = | { kind: 'treasury'; accountId: string }
    | { kind: 'caja'; sessionId: string };

export type SupplierPaymentInput = {
  organizationId: string;
  supplierId: string;
  fundingSource: SupplierPaymentFundingSource;
  amount: number;
  createdBy: string;
  note?: string | null;
};

export type SupplierPaymentBreakdown = {
  payableId: string;
  chunk: number;
  payableStatus: 'open' | 'partial' | 'paid';
  /** Set only for caja-funded chunks; undefined for treasury-funded chunks. */
  cashMovementId?: string;
};

export type SupplierPaymentResult = {
  appliedTotal: number;
  excess: number;
  breakdown: SupplierPaymentBreakdown[];
};

export async function recordSupplierPayment(
  executor: Executor,
  input: SupplierPaymentInput,
): Promise<SupplierPaymentResult> {
  const requestedAmt = round2(input.amount);

  if (requestedAmt <= 0) {
    throw new Error('amount must be greater than zero');
  }

  // ── 1. Unlocked read of all open/partial payables for the supplier ──────────
  //    Oldest-first across ALL invoices for this supplier.
  const payables = await executor
    .select({
      id: supplierPayablesSchema.id,
      supplierId: supplierPayablesSchema.supplierId,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
    })
    .from(supplierPayablesSchema)
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, input.organizationId),
        eq(supplierPayablesSchema.supplierId, input.supplierId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(
      asc(supplierPayablesSchema.purchasedAt),
      asc(supplierPayablesSchema.id),
    );

  if (payables.length === 0) {
    // No outstanding debt — caller should route to gasto instead.
    return { appliedTotal: 0, excess: requestedAmt, breakdown: [] };
  }

  // ── 2. Compute allocation oldest-first ────────────────────────────────────
  type Allocation = { payableId: string; supplierId: string; chunk: number };
  const allocations: Allocation[] = [];
  let remaining = requestedAmt;

  for (const p of payables) {
    if (remaining <= 0) {
      break;
    }
    const total = round2(Number.parseFloat(p.totalAmount));
    const paid = round2(Number.parseFloat(p.paidAmount));
    const credited = round2(Number.parseFloat(p.creditedAmount ?? '0'));
    const outstanding = round2(total - paid - credited);
    if (outstanding <= 0) {
      continue;
    }
    const chunk = round2(Math.min(remaining, outstanding));
    allocations.push({ payableId: p.id, supplierId: p.supplierId, chunk });
    remaining = round2(remaining - chunk);
  }

  const appliedTotal = round2(requestedAmt - remaining);
  const excess = round2(remaining); // > 0 if amount > total outstanding

  // ── 3. Execute inside ONE outer transaction ───────────────────────────────
  const doWork = async (tx: Executor): Promise<SupplierPaymentResult> => {
    const breakdown: SupplierPaymentBreakdown[] = [];

    for (const alloc of allocations) {
      if (input.fundingSource.kind === 'treasury') {
        const chunkResult = await recordSupplierPaymentOutflow(tx, {
          organizationId: input.organizationId,
          fromAccountId: input.fundingSource.accountId,
          amount: alloc.chunk,
          supplierId: alloc.supplierId,
          payableId: alloc.payableId,
          note: input.note ?? null,
          createdBy: input.createdBy,
        });
        breakdown.push({
          payableId: alloc.payableId,
          chunk: alloc.chunk,
          payableStatus: chunkResult.payableStatus,
        });
      } else {
        // kind === 'caja'
        const chunkResult = await recordCajaPayableSettle(tx, {
          organizationId: input.organizationId,
          sessionId: input.fundingSource.sessionId,
          payableId: alloc.payableId,
          supplierId: alloc.supplierId,
          amount: alloc.chunk,
          note: input.note ?? null,
          createdBy: input.createdBy,
        });
        breakdown.push({
          payableId: alloc.payableId,
          chunk: alloc.chunk,
          payableStatus: chunkResult.payableStatus,
          cashMovementId: chunkResult.cashMovementId,
        });
      }
    }

    return { appliedTotal, excess, breakdown };
  };

  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as { transaction: <T>(cb: (tx: Executor) => Promise<T>) => Promise<T> })
      .transaction(tx => doWork(tx));
  }
  return doWork(executor);
}
