// Pure routing helper for gasto source selection. Kept in its own module (not in
// ExpensesClient.tsx) so the component file only exports components — required by
// react-refresh/only-export-components.

/**
 * Determines how to record a gasto given the selected source:
 *   - treasuryAccountId present → recordGasto (dual write: expenses + treasury_movements)
 *   - null / cash → createExpense (legacy cash path, unchanged)
 *
 * This routing is the ONLY guard against double-write: when recordGasto is used,
 * createExpense is NOT called (recordGasto already inserts the expenses row).
 */
export function resolveExpenseSource(
  treasuryAccountId: string | null,
  cashLabel: string,
): { type: 'treasury'; accountId: string } | { type: 'cash' } {
  if (
    treasuryAccountId
    && treasuryAccountId !== ''
    && treasuryAccountId !== cashLabel
  ) {
    return { type: 'treasury', accountId: treasuryAccountId };
  }
  return { type: 'cash' };
}

// Sentinel value used in the select to represent "cash / no treasury account".
export const CASH_SENTINEL = '__cash__';
