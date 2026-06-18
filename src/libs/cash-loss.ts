/**
 * Cash-loss (faltante) helpers — Slice 1 + Slice 2.
 *
 * Slice 1: placeHandoverAsLoss
 *   Records a cash loss against a pending handover.
 *   - Drains handover.remaining by `amount` (via per-handover guard in recordGastoOutflow).
 *   - Inserts a positive `expenses` row with category='faltante' (lowers utilidad).
 *   - Inserts a `treasury_movements` gasto row (drains transito balance).
 *   - Category is ALWAYS 'faltante' — the server enforces this, never the client.
 *
 * Slice 2: listRecoverableLosses + recoverLoss
 *   listRecoverableLosses: returns faltante expenses not yet reversed.
 *   recoverLoss: atomic single transaction:
 *     1. correctGastoExpense — reverses the faltante expense (P&L restored) and
 *        returns money to the transito/pending container via a compensating entrada.
 *     2. Routes the recovered amount:
 *        - 'caja_fuerte' → recordContainerTransfer(transito → cofre)
 *        - 'banco'       → recordContainerTransfer(transito → banco)
 *        - 'pendiente'   → create a new handover movement (type='handover',
 *                          cash_session_id=NULL) so it reappears in listPendingHandovers.
 *
 * No migration is required: treasury_movements.cash_session_id is already
 * nullable (added without NOT NULL in migration 0053). listPendingHandovers uses
 * a LEFT JOIN to cash_sessions and already handles null cashierName.
 * When cash_session_id IS NULL, origin shows 'Cierre de caja'; for recovered
 * handovers we insert reason='Recuperación de faltante' and listPendingHandovers
 * now returns reason as origin fallback (see below).
 */

import type { db } from '@/libs/DB';
import { and, eq, isNull, not } from 'drizzle-orm';
import { toMoney } from '@/libs/cash-helpers';
import { correctGastoExpense } from '@/libs/expense-correction';
import {
  getOrCreatePendingAccount,
  recordContainerTransfer,
} from '@/libs/treasury';
import {
  expensesSchema,
  treasuryMovementsSchema,
} from '@/models/Schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Input types ───────────────────────────────────────────────────────────────

export type PlaceHandoverAsLossInput = {
  organizationId: string;
  handoverMovementId: string;
  amount: number | string;
  /** Optional free-text note appended to the description. */
  note?: string | null;
  /** ISO date string YYYY-MM-DD for incurred_on. */
  incurredOn: string;
  createdBy: string;
};

export type RecoverableLoss = {
  id: string;
  amount: number;
  incurredOn: string;
  description: string | null;
};

export type RecoverLossInput = {
  organizationId: string;
  expenseId: string;
  destination: 'caja_fuerte' | 'banco' | 'pendiente';
  /**
   * Required for 'caja_fuerte' and 'banco' — the treasury_accounts.id of the
   * receiving container. Not used for 'pendiente'.
   */
  accountId?: string;
  correctedBy: string;
};

// ── Slice 1: placeHandoverAsLoss ──────────────────────────────────────────────

/**
 * Records a cash loss (faltante) against a pending handover.
 *
 * Delegates to recordGastoOutflow with category='faltante'. This function
 * exists to:
 *   a) enforce category='faltante' server-side (the UI cannot override it), and
 *   b) build the canonical description from note.
 *
 * Returns the new expense.id.
 */
export async function placeHandoverAsLoss(
  executor: Executor,
  input: PlaceHandoverAsLossInput,
): Promise<string> {
  const amt = Number.parseFloat(toMoney(input.amount));
  const base = 'Faltante de efectivo';
  const description = input.note?.trim()
    ? `${base}: ${input.note.trim()}`
    : base;

  // Delegate entirely to recordGastoOutflow — it handles:
  //   - source balance check
  //   - per-handover remaining guard
  //   - atomic expenses + treasury_movements insert
  const { recordGastoOutflow } = await import('@/libs/treasury');
  const pending = await getOrCreatePendingAccount(executor, input.organizationId, input.createdBy);

  return recordGastoOutflow(executor, {
    organizationId: input.organizationId,
    fromAccountId: pending.id,
    amount: String(amt),
    category: 'faltante',
    description,
    incurredOn: input.incurredOn,
    createdBy: input.createdBy,
    handoverMovementId: input.handoverMovementId,
  });
}

// ── Slice 2: listRecoverableLosses ────────────────────────────────────────────

/**
 * Returns faltante expenses that have NOT yet been reversed.
 * A loss is "recoverable" when:
 *   - category = 'faltante'
 *   - amount > 0 (positive row — not a reversal itself)
 *   - no expenses row with reverses_expense_id = this row's id exists
 *
 * Scoped to organizationId.
 */
export async function listRecoverableLosses(
  executor: Executor,
  organizationId: string,
): Promise<RecoverableLoss[]> {
  // Subquery approach: expenses where no reversal references them.
  // We use a NOT EXISTS pattern via a LEFT JOIN to the reversal.
  const rows = await executor
    .select({
      id: expensesSchema.id,
      amount: expensesSchema.amount,
      incurredOn: expensesSchema.incurredOn,
      description: expensesSchema.description,
    })
    .from(expensesSchema)
    .where(
      and(
        eq(expensesSchema.organizationId, organizationId),
        eq(expensesSchema.category, 'faltante'),
        isNull(expensesSchema.reversesExpenseId), // positive row (not a reversal)
      ),
    )
    .orderBy(expensesSchema.createdAt);

  if (rows.length === 0) {
    return [];
  }

  // Filter out already-reversed rows by checking for a reversal referencing them.
  // Done in-process to avoid a complex NOT EXISTS subquery in Drizzle ORM.
  const allReversals = await executor
    .select({ reversesExpenseId: expensesSchema.reversesExpenseId })
    .from(expensesSchema)
    .where(
      and(
        eq(expensesSchema.organizationId, organizationId),
        not(isNull(expensesSchema.reversesExpenseId)),
      ),
    );

  const reversedIds = new Set(allReversals.map(r => r.reversesExpenseId).filter(Boolean));

  return rows
    .filter(r => !reversedIds.has(r.id))
    .map(r => ({
      id: r.id,
      amount: Number.parseFloat(r.amount),
      incurredOn: typeof r.incurredOn === 'string' ? r.incurredOn : String(r.incurredOn),
      description: r.description ?? null,
    }));
}

// ── Slice 2: recoverLoss ──────────────────────────────────────────────────────

/**
 * Recovers a previously recorded faltante in a single transaction.
 *
 * Steps:
 * 1. correctGastoExpense — reverses the faltante expense (P&L +amount) and posts
 *    a compensating treasury_movements entrada restoring money to the transito container.
 * 2. Route the recovered amount from transito:
 *    - 'caja_fuerte' → recordContainerTransfer(transito → accountId)
 *    - 'banco'       → recordContainerTransfer(transito → accountId)
 *    - 'pendiente'   → insert a new type='handover' movement (cash_session_id=NULL)
 *                      so it appears in listPendingHandovers with origin='Recuperación de faltante'.
 *
 * Throws if the expense is not found, already reversed, or if accountId is
 * missing when destination requires it.
 */
export async function recoverLoss(
  executor: Executor,
  input: RecoverLossInput,
): Promise<void> {
  if (
    (input.destination === 'caja_fuerte' || input.destination === 'banco')
    && !input.accountId
  ) {
    throw new Error(`recoverLoss: accountId is required for destination '${input.destination}'`);
  }

  const doRecover = async (tx: Executor): Promise<void> => {
    // 1. Load the original expense to get its amount before correction.
    const [original] = await tx
      .select({ amount: expensesSchema.amount })
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
        `recoverLoss: expense ${input.expenseId} not found in org ${input.organizationId}`,
      );
    }

    const recoveredAmount = Number.parseFloat(original.amount);

    // 2. Reverse the expense + restore money to transito.
    //    correctGastoExpense already handles the idempotency guard.
    await correctGastoExpense(tx, {
      organizationId: input.organizationId,
      expenseId: input.expenseId,
      correctedBy: input.correctedBy,
    });

    // 3. The compensating entrada from correctGastoExpense has restored money to
    //    the transito container. Now route it to the chosen destination.
    const pending = await getOrCreatePendingAccount(tx, input.organizationId, input.correctedBy);

    if (input.destination === 'caja_fuerte' || input.destination === 'banco') {
      // Transfer from transito to the specified container.
      await recordContainerTransfer(tx, {
        organizationId: input.organizationId,
        fromAccountId: pending.id,
        toAccountId: input.accountId!,
        amount: String(recoveredAmount),
        createdBy: input.correctedBy,
        reason: 'Recuperación de faltante',
      });
    } else {
      // 'pendiente': create a new handover row that appears in listPendingHandovers.
      // cash_session_id = NULL (no linked session — this is a recovery, not a close).
      // reason = 'Recuperación de faltante' — used as origin fallback by
      // listPendingHandovers (the query falls back to reason when deviceName is null).
      await tx
        .insert(treasuryMovementsSchema)
        .values({
          organizationId: input.organizationId,
          fromAccountId: null,
          toAccountId: pending.id,
          amount: toMoney(recoveredAmount),
          type: 'handover',
          reason: 'Recuperación de faltante',
          cashSessionId: null,
          createdBy: input.correctedBy,
        });
    }
  };

  // Wrap in a transaction when called with the real db.
  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    await (executor as typeof import('@/libs/DB').db).transaction(
      tx => doRecover(tx as unknown as Executor),
    );
  } else {
    await doRecover(executor);
  }
}
