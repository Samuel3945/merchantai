/**
 * Tests for the gasto source-routing logic in ExpensesClient.
 *
 * The core invariant is: when a treasury account is selected, recordGasto is
 * called (dual write) and createExpense is NOT called. When cash/sentinel is
 * selected (or no treasury accounts exist), only createExpense is called.
 *
 * These tests cover resolveExpenseSource — the pure routing guard — which is the
 * only non-trivial logic in the client component that doesn't involve React or
 * server actions (which require a Next.js runtime and can't be unit-tested here).
 */

import { describe, expect, it } from 'vitest';
import { resolveExpenseSource } from './expenses-routing';

const CASH_SENTINEL = '__cash__';

describe('resolveExpenseSource', () => {
  it('returns type=cash when sentinel is selected', () => {
    const result = resolveExpenseSource(CASH_SENTINEL, CASH_SENTINEL);

    expect(result).toEqual({ type: 'cash' });
  });

  it('returns type=cash when accountId is null', () => {
    const result = resolveExpenseSource(null, CASH_SENTINEL);

    expect(result).toEqual({ type: 'cash' });
  });

  it('returns type=cash when accountId is empty string', () => {
    const result = resolveExpenseSource('', CASH_SENTINEL);

    expect(result).toEqual({ type: 'cash' });
  });

  it('returns type=treasury with accountId when a UUID is selected', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const result = resolveExpenseSource(uuid, CASH_SENTINEL);

    expect(result).toEqual({ type: 'treasury', accountId: uuid });
  });

  it('returns type=treasury for caja_fuerte account UUID', () => {
    const vaultId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const result = resolveExpenseSource(vaultId, CASH_SENTINEL);

    expect(result.type).toBe('treasury');

    if (result.type === 'treasury') {
      expect(result.accountId).toBe(vaultId);
    }
  });

  it('returns type=treasury for banco account UUID', () => {
    const bancoId = 'bbbbbbbb-0000-4000-8000-000000000002';
    const result = resolveExpenseSource(bancoId, CASH_SENTINEL);

    expect(result.type).toBe('treasury');

    if (result.type === 'treasury') {
      expect(result.accountId).toBe(bancoId);
    }
  });

  it('never returns both treasury and cash simultaneously (no double-write)', () => {
    const uuid = 'cccccccc-0000-4000-8000-000000000003';
    const result = resolveExpenseSource(uuid, CASH_SENTINEL);

    // Exactly one type must be returned.
    expect(['treasury', 'cash']).toContain(result.type);

    // When treasury, there must be an accountId and type must NOT be 'cash'.
    if (result.type === 'treasury') {
      expect(result.accountId).toBe(uuid);
    }
  });

  it('treats sentinel string as cash even if org has treasury accounts', () => {
    // Simulates the case where the owner explicitly picks "Efectivo / caja".
    const result = resolveExpenseSource(CASH_SENTINEL, CASH_SENTINEL);

    expect(result.type).toBe('cash');
  });

  it('is deterministic: same input always produces same output', () => {
    const uuid = 'dddddddd-0000-4000-8000-000000000004';
    const r1 = resolveExpenseSource(uuid, CASH_SENTINEL);
    const r2 = resolveExpenseSource(uuid, CASH_SENTINEL);

    expect(r1).toEqual(r2);
  });
});
