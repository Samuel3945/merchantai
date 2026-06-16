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
