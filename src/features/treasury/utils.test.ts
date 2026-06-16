import type { TreasuryAccount } from '@/libs/treasury';
import { describe, expect, it } from 'vitest';
import { sumBancos, sumEfectivo } from './utils';

function acct(type: TreasuryAccount['type'], balance: number): TreasuryAccount {
  return { key: `${type}:${balance}`, name: type, type, balance };
}

const mixed: TreasuryAccount[] = [
  acct('caja', 10_000_000),
  acct('caja', 5_000_000),
  acct('caja_fuerte', 10_000_000),
  acct('banco', 8_000_000),
  acct('banco', 2_000_000),
  acct('banco', 3_500_000),
];

describe('sumEfectivo', () => {
  it('sums caja and caja_fuerte balances and excludes banco', () => {
    expect(sumEfectivo(mixed)).toBe(25_000_000);
  });

  it('returns 0 for an empty list', () => {
    expect(sumEfectivo([])).toBe(0);
  });

  it('returns 0 when there are only banco accounts', () => {
    expect(sumEfectivo([acct('banco', 1_000)])).toBe(0);
  });
});

describe('sumBancos', () => {
  it('sums only banco balances and excludes caja and caja_fuerte', () => {
    expect(sumBancos(mixed)).toBe(13_500_000);
  });

  it('returns 0 for an empty list', () => {
    expect(sumBancos([])).toBe(0);
  });
});

describe('efectivo + bancos buckets', () => {
  it('partition the whole position with no overlap and no dropped type', () => {
    const total = mixed.reduce((acc, a) => acc + a.balance, 0);

    expect(sumEfectivo(mixed) + sumBancos(mixed)).toBe(total);
  });
});
