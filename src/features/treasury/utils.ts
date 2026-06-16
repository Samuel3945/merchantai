import type { TreasuryAccount } from '@/libs/treasury';

/**
 * Computes the EFECTIVO bucket: Σ balances where type ∈ {caja, caja_fuerte}.
 * Pure function — testable without a DB.
 */
export function sumEfectivo(accounts: TreasuryAccount[]): number {
  return accounts
    .filter(a => a.type === 'caja' || a.type === 'caja_fuerte')
    .reduce((acc, a) => acc + a.balance, 0);
}

/**
 * Computes the BANCOS bucket: Σ balances where type = 'banco'.
 * Pure function — testable without a DB.
 */
export function sumBancos(accounts: TreasuryAccount[]): number {
  return accounts
    .filter(a => a.type === 'banco')
    .reduce((acc, a) => acc + a.balance, 0);
}

/**
 * Groups a flat TreasuryAccount[] into the hierarchical EMPRESA tree:
 *   EMPRESA → EFECTIVO (caja + caja_fuerte) + BANCOS (banco)
 *
 * Pure function — no DB, no side effects.
 * Subtotals must be derived from these same leaves to avoid double-counting.
 */
export type MoneyTree = {
  /** EFECTIVO branch: all caja and caja_fuerte accounts */
  efectivo: TreasuryAccount[];
  /** BANCOS branch: all banco accounts */
  bancos: TreasuryAccount[];
};

export function groupByType(accounts: TreasuryAccount[]): MoneyTree {
  return {
    efectivo: accounts.filter(a => a.type === 'caja' || a.type === 'caja_fuerte'),
    bancos: accounts.filter(a => a.type === 'banco'),
  };
}
