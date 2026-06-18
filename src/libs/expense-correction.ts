/**
 * Delete-as-correction for posted gastos (ADR-3).
 *
 * Posted `expenses` rows are immutable — the RESTRICT FK on
 * treasury_movements.expense_id and cash_movements.expense_id enforces this at
 * the DB level. A "delete" becomes a referenced reversing correction:
 *
 * For treasury-sourced gastos:
 *   1. Insert a negative-amount `expenses` row (reversal) — P&L nets to zero.
 *   2. Insert a compensating `treasury_movements` entrada to restore the
 *      container balance.
 *
 * For POS-sourced gastos (v1 scope — owner/dashboard side only):
 *   1. Insert a negative-amount `expenses` row (reversal) — P&L nets to zero.
 *   The original `cash_movements` row stays read-only. Drawer-side correction
 *   remains the cashier's arqueo concern (out of scope here).
 *
 * For legacy (no linked movement): only the reversing expenses row.
 *
 * The original row is NEVER mutated. `net-profit.ts` SUM remains correct with
 * zero code change because SUM(original + negative reversal) = 0.
 */

import type { db } from '@/libs/DB';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  expensesSchema,
  treasuryMovementsSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CorrectGastoInput = {
  organizationId: string;
  expenseId: string;
  /** Clerk userId of the owner posting the correction. */
  correctedBy: string;
};

export type CorrectGastoResult = {
  /** ID of the newly inserted reversing expenses row. */
  reversalExpenseId: string;
  /** ID of the new treasury_movements entrada (only for treasury-sourced gastos). */
  compensatingMovementId?: string;
};

function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return n.toFixed(2);
}

export async function correctGastoExpense(
  executor: Executor,
  input: CorrectGastoInput,
): Promise<CorrectGastoResult> {
  const doCorrection = async (tx: Executor): Promise<CorrectGastoResult> => {
    // 1. Load and verify the original expense (org-scoped guard).
    const [original] = await tx
      .select()
      .from(expensesSchema)
      .where(
        and(
          eq(expensesSchema.id, input.expenseId),
          eq(expensesSchema.organizationId, input.organizationId),
        ),
      )
      .limit(1);

    if (!original) {
      throw new Error(
        `correctGastoExpense: expense ${input.expenseId} not found in org ${input.organizationId}`,
      );
    }

    const originalAmount = Number.parseFloat(original.amount);

    // 1a. Idempotency guard (C1): cannot correct a row that is itself a
    // reversal — i.e. an already-posted correction. The reverses_expense_id
    // column is the source of truth; the negative-amount check is a belt-and
    // -suspenders guard for legacy reversals predating this column.
    if (original.reversesExpenseId || originalAmount < 0) {
      throw new Error(
        `correctGastoExpense: expense ${input.expenseId} is a correction and cannot be corrected`,
      );
    }

    // 1b. Idempotency guard (C1): reject if a reversal already references this
    // expense. The PARTIAL UNIQUE index on reverses_expense_id is the ultimate
    // backstop for concurrent double-corrections; this read-side check fails
    // fast with a friendly message inside the same transaction.
    const [existingReversal] = await tx
      .select({ id: expensesSchema.id })
      .from(expensesSchema)
      .where(
        and(
          eq(expensesSchema.reversesExpenseId, input.expenseId),
          eq(expensesSchema.organizationId, input.organizationId),
        ),
      )
      .limit(1);

    if (existingReversal) {
      throw new Error(
        `correctGastoExpense: expense ${input.expenseId} has already been corrected`,
      );
    }

    // 2. Determine source: look for a treasury_movements gasto linked to this expense.
    const [linkedTreasuryMov] = await tx
      .select({
        id: treasuryMovementsSchema.id,
        fromAccountId: treasuryMovementsSchema.fromAccountId,
      })
      .from(treasuryMovementsSchema)
      .where(
        and(
          eq(treasuryMovementsSchema.expenseId, input.expenseId),
          eq(treasuryMovementsSchema.organizationId, input.organizationId),
          isNotNull(treasuryMovementsSchema.fromAccountId),
        ),
      )
      .limit(1);

    // 3. Insert reversing expenses row (negative amount). The
    // reverses_expense_id COLUMN is the source of truth for "already corrected"
    // (the PARTIAL UNIQUE index makes a second insert collide at the DB). The
    // description is kept for human readability only.
    const reversalDescription = `Corrección de gasto ${input.expenseId}`;

    const [reversalRow] = await tx
      .insert(expensesSchema)
      .values({
        organizationId: input.organizationId,
        amount: toMoney(-originalAmount),
        category: original.category,
        description: reversalDescription,
        incurredOn: original.incurredOn,
        createdBy: input.correctedBy,
        reversesExpenseId: input.expenseId,
      })
      .returning({ id: expensesSchema.id });

    if (!reversalRow) {
      throw new Error('correctGastoExpense: reversal expenses insert returned no row');
    }

    // 4. Treasury-sourced: post a compensating entrada to restore the container.
    let compensatingMovementId: string | undefined;
    if (linkedTreasuryMov) {
      const toAccountId = linkedTreasuryMov.fromAccountId;
      const [compMov] = await tx
        .insert(treasuryMovementsSchema)
        .values({
          organizationId: input.organizationId,
          fromAccountId: null,
          toAccountId,
          amount: toMoney(originalAmount),
          type: 'entrada',
          reason: `Corrección de gasto ${input.expenseId}`,
          createdBy: input.correctedBy,
        })
        .returning({ id: treasuryMovementsSchema.id });

      if (!compMov) {
        throw new Error('correctGastoExpense: compensating treasury_movements insert returned no row');
      }
      compensatingMovementId = compMov.id;
    }

    return {
      reversalExpenseId: reversalRow.id,
      compensatingMovementId,
    };
  };

  // Wrap in transaction when executor is the real db (same pattern as recordGastoOutflow).
  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as typeof import('@/libs/DB').db).transaction(
      tx => doCorrection(tx as unknown as Executor),
    );
  }
  return doCorrection(executor);
}
