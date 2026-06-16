import type { TreasuryAccount } from '@/libs/treasury';
import { describe, expect, it } from 'vitest';
import { classifyTimelineDirection, sumBancos, sumEfectivo, wasSessionHandedOver } from './utils';

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

describe('wasSessionHandedOver', () => {
  it('returns true when account is caja, sessionId is set, and map says true', () => {
    const account: Pick<TreasuryAccount, 'type' | 'sessionId'> = { type: 'caja', sessionId: 'ses-1' };

    expect(wasSessionHandedOver(account, { 'ses-1': true })).toBe(true);
  });

  it('returns false when account is caja but map says false', () => {
    const account: Pick<TreasuryAccount, 'type' | 'sessionId'> = { type: 'caja', sessionId: 'ses-1' };

    expect(wasSessionHandedOver(account, { 'ses-1': false })).toBe(false);
  });

  it('returns false when account type is not caja (e.g. caja_fuerte)', () => {
    const account: Pick<TreasuryAccount, 'type' | 'sessionId'> = { type: 'caja_fuerte', sessionId: 'ses-1' };

    expect(wasSessionHandedOver(account, { 'ses-1': true })).toBe(false);
  });

  it('returns false when sessionId is undefined', () => {
    const account: Pick<TreasuryAccount, 'type' | 'sessionId'> = { type: 'caja', sessionId: undefined };

    expect(wasSessionHandedOver(account, { 'ses-1': true })).toBe(false);
  });

  it('returns false when no map is provided (default OFF)', () => {
    const account: Pick<TreasuryAccount, 'type' | 'sessionId'> = { type: 'caja', sessionId: 'ses-1' };

    expect(wasSessionHandedOver(account)).toBe(false);
  });
});

describe('classifyTimelineDirection', () => {
  it('is neutral when money moves between two internal containers (transfer/consignación)', () => {
    expect(
      classifyTimelineDirection({ fromAccount: 'Caja POS', toAccount: 'Caja Fuerte' }),
    ).toBe('neutral');
  });

  it('is an inflow when there is only a destination (entrada/deposito)', () => {
    expect(
      classifyTimelineDirection({ fromAccount: null, toAccount: 'Bancolombia' }),
    ).toBe('in');
  });

  it('is an outflow when there is only a source (gasto/salida)', () => {
    expect(
      classifyTimelineDirection({ fromAccount: 'Caja Fuerte', toAccount: null }),
    ).toBe('out');
  });

  it('is neutral when neither end is present', () => {
    expect(
      classifyTimelineDirection({ fromAccount: null, toAccount: null }),
    ).toBe('neutral');
  });
});
