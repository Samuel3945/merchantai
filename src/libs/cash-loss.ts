/**
 * Cash-loss (faltante) helper — Slice 1.
 *
 * placeHandoverAsLoss
 *   Records a cash loss (faltante) against a pending handover.
 *   - Drains handover.remaining by `amount` (via per-handover guard in recordGastoOutflow).
 *   - Inserts a positive `expenses` row with category='faltante' (lowers utilidad).
 *   - Inserts a `treasury_movements` gasto row (drains transito balance).
 *   - Category is ALWAYS 'faltante' — the server enforces this, never the client.
 *
 * Recovery (when the money reappears) is handled generically from the gastos
 * history via correctGastoExpense: it reverses the faltante expense (P&L
 * restored) and returns the cash to the transito/pending container. There is no
 * dedicated recover surface — a faltante is a normal expense row.
 */

import type { db } from '@/libs/DB';
import { toMoney } from '@/libs/cash-helpers';
import { getOrCreatePendingAccount } from '@/libs/treasury';

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

// ── placeHandoverAsLoss ───────────────────────────────────────────────────────

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
  // M1: wrap in a transaction so getOrCreatePendingAccount + recordGastoOutflow
  // share the same FOR UPDATE lock scope, matching placeHandoverToBanco/AsGasto.
  const { recordGastoOutflow } = await import('@/libs/treasury');

  const doPlace = async (tx: Executor): Promise<string> => {
    const pending = await getOrCreatePendingAccount(tx, input.organizationId, input.createdBy);
    return recordGastoOutflow(tx, {
      organizationId: input.organizationId,
      fromAccountId: pending.id,
      amount: String(amt),
      category: 'faltante',
      description,
      incurredOn: input.incurredOn,
      createdBy: input.createdBy,
      handoverMovementId: input.handoverMovementId,
    });
  };

  const isRealDb = typeof (executor as { transaction?: unknown }).transaction === 'function';
  if (isRealDb) {
    return (executor as typeof import('@/libs/DB').db).transaction(
      tx => doPlace(tx as unknown as Executor),
    );
  }
  return doPlace(executor);
}
