// gasto-treasury-unification slice 1: POS→P&L bridge helper.
//
// Mirrors the pattern of recordGastoOutflow (treasury.ts:797-846):
//   1. Insert expenses row first (P&L anchor, org-scoped).
//   2. Insert cash_movements row with expense_id back-pointer.
//
// The bridge fires ONLY for type='expense'. All other movement types
// (salary, inventory_purchase, withdrawal, advance, etc.) keep the plain
// insert path in the route and MUST NOT call this helper — double-count guard.
//
// Executor pattern: when called with the real `db`, wraps in a new transaction.
// When called with an existing `tx`, uses it directly (passthrough). This lets
// the POS route call us inside its already-open transaction for atomicity.

import type { db } from '@/libs/DB';
import { toMoney } from '@/libs/cash-helpers';
import { cashMovementsSchema, expensesSchema } from '@/models/Schema';
import { todayBogota } from '@/utils/DateRange';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PosGastoBridgeInput = {
  organizationId: string;
  sessionId: string;
  amount: number | string;
  /** Device `reason` field — stored as expenses.description so context survives */
  reason: string;
  createdBy: string;
};

export type PosGastoBridgeResult = {
  /** The created cash_movements row id */
  movementId: string;
  /** The created expenses row id */
  expenseId: string;
};

/**
 * Records a POS expense movement as a dual-write:
 *   - one `expenses` row (P&L anchor, category='otros', description=reason)
 *   - one `cash_movements` row (type='expense', expense_id → expenses.id)
 *
 * The two inserts are atomic: either both succeed or neither does.
 *
 * IMPORTANT: call this ONLY when type==='expense'. The route is responsible
 * for the type guard; this helper asserts nothing about type.
 */
export async function recordPosGastoBridge(
  executor: Executor,
  input: PosGastoBridgeInput,
): Promise<PosGastoBridgeResult> {
  const amt = toMoney(input.amount);

  const doInserts = async (tx: Executor): Promise<PosGastoBridgeResult> => {
    // 1. Insert expenses row (P&L anchor).
    // Category defaults to 'otros' — ADR-2: device has no category picker.
    // description = reason so the operator sees why the cash left.
    // incurredOn = today in Bogota timezone (device has no date concept).
    const [expense] = await tx
      .insert(expensesSchema)
      .values({
        organizationId: input.organizationId,
        amount: amt,
        category: 'otros',
        description: input.reason,
        incurredOn: todayBogota(),
        createdBy: input.createdBy,
      })
      .returning({ id: expensesSchema.id });

    if (!expense) {
      throw new Error('pos-gasto-bridge: expenses insert returned no row');
    }

    // 2. Insert cash_movements row with back-pointer to the expenses anchor.
    const [movement] = await tx
      .insert(cashMovementsSchema)
      .values({
        sessionId: input.sessionId,
        organizationId: input.organizationId,
        type: 'expense',
        amount: amt,
        reason: input.reason,
        expenseId: expense.id,
        createdBy: input.createdBy,
      })
      .returning({ id: cashMovementsSchema.id });

    if (!movement) {
      throw new Error('pos-gasto-bridge: cash_movements insert returned no row');
    }

    return { movementId: movement.id, expenseId: expense.id };
  };

  // When executor is the real `db`, wrap in a transaction for atomicity.
  // When executor is already a tx (passed from a parent transaction), use it
  // directly — nesting another transaction here would isolate the writes and
  // break the caller's atomicity guarantee.
  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as typeof import('@/libs/DB').db).transaction(
      tx => doInserts(tx as unknown as Executor),
    );
  }
  return doInserts(executor);
}
