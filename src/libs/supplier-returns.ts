import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  supplierPayableCreditsSchema,
  supplierPayablesSchema,
} from '@/models/Schema';

// Executor is typed as `any` to bridge three compatible-but-structurally-distinct
// types: plain Drizzle db (PGLite tests), Drizzle tx handle, and TenantDb / TenantDb-tx.
// All exported function signatures are explicit; call sites are type-checked.
// biome-ignore lint/suspicious/noExplicitAny: bridges Drizzle db/tx/TenantDb structural mismatch
type Executor = any;

// ── applyReturnCredit ─────────────────────────────────────────────────────────
//
// Applies a supplier return credit FIFO-oldest-first across the supplier's open
// or partial payables. Called INSIDE the same transaction as the return_supplier
// stock_movements insert (atomicity: REQ design decision 6).
//
// Lock order: payables only (no container lock for a pure return — no cash moves).
// This is safe because the only other helper that locks supplier_payables is
// recordSupplierPaymentOutflow, which first locks treasury_accounts then payables
// (D3 container→payable order). A pure return never touches treasury_accounts,
// so there is no cross-table cycle: the container lock is never acquired here,
// so no helper holding a payable lock can be blocked by us waiting for a container
// (we never wait for one). Deadlock-free for the same reason D3 is (both helpers
// always acquire payable locks in the same ascending-id order from the DB).
//
// Algorithm:
//   1. SELECT open+partial payables FOR UPDATE, ordered by purchased_at ASC (FIFO).
//   2. Walk payables:
//       a. outstanding_i = total_i − paid_i − credited_i  (floor 0)
//       b. take = min(remaining, outstanding_i)
//       c. INSERT supplier_payable_credits row for `take`
//       d. UPDATE supplier_payables.credited_amount += take, recompute status
//       e. remaining -= take; break when remaining == 0
//   3. Return { appliedTotal, unapplied }.
//
// Does NOT write treasury_movements or expenses (liability credit only).
// Does NOT mutate supplier_payables.total_amount (immutability invariant).

export type ApplyReturnCreditInput = {
  organizationId: string;
  supplierId: string;
  returnStockMovementId: string;
  amount: number;
  createdBy: string;
  note?: string | null;
};

export type ApplyReturnCreditResult = {
  appliedTotal: number;
  unapplied: number;
  creditIds: string[];
};

export async function applyReturnCredit(
  executor: Executor,
  input: ApplyReturnCreditInput,
): Promise<ApplyReturnCreditResult> {
  const { organizationId, supplierId, returnStockMovementId, amount, createdBy, note } = input;

  if (amount <= 0) {
    throw new Error(
      `applyReturnCredit: amount must be > 0 (got ${amount})`,
    );
  }

  // 1. Lock open+partial payables for this supplier in purchased_at ASC order
  //    (FIFO: oldest debt gets credited first). FOR UPDATE serializes concurrent
  //    return transactions against the same supplier.
  const payables = await executor
    .select({
      id: supplierPayablesSchema.id,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      creditedAmount: supplierPayablesSchema.creditedAmount,
      status: supplierPayablesSchema.status,
      purchasedAt: supplierPayablesSchema.purchasedAt,
    })
    .from(supplierPayablesSchema)
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, organizationId),
        eq(supplierPayablesSchema.supplierId, supplierId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(asc(supplierPayablesSchema.purchasedAt))
    .for('update');

  let remaining = amount;
  let appliedTotal = 0;
  const creditIds: string[] = [];

  // 2. Walk payables FIFO, applying credit chunks.
  for (const payable of payables) {
    if (remaining <= 0) {
      break;
    }

    const total = Number.parseFloat(payable.totalAmount);
    const paid = Number.parseFloat(payable.paidAmount);
    const credited = Number.parseFloat(payable.creditedAmount ?? '0');
    const outstanding = Math.max(0, total - paid - credited);

    if (outstanding <= 0) {
      continue;
    }

    const take = Math.min(remaining, outstanding);

    // 3. Write the credit chunk row.
    const [creditRow] = await executor
      .insert(supplierPayableCreditsSchema)
      .values({
        organizationId,
        supplierId,
        payableId: payable.id,
        returnStockMovementId,
        amount: take.toFixed(2),
        note: note ?? null,
        createdBy,
      })
      .returning({ id: supplierPayableCreditsSchema.id });

    if (!creditRow) {
      throw new Error('supplier_payable_credits: insert returned no row');
    }

    creditIds.push(creditRow.id);

    // 4. Update credited_amount and recompute status.
    const newCredited = credited + take;
    const newStatus: 'open' | 'partial' | 'paid'
      = paid + newCredited >= total - 0.005 ? 'paid' : (newCredited > 0 ? 'partial' : 'open');

    await executor
      .update(supplierPayablesSchema)
      .set({
        creditedAmount: newCredited.toFixed(2),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(supplierPayablesSchema.id, payable.id));

    appliedTotal += take;
    remaining -= take;
  }

  return {
    appliedTotal,
    unapplied: remaining,
    creditIds,
  };
}
