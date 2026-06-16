import type { TreasuryAccount } from '@/libs/treasury';
import { describe, expect, it } from 'vitest';
import { groupByType } from '../utils';

function acct(
  type: TreasuryAccount['type'],
  name: string,
  balance: number,
): TreasuryAccount {
  return { key: `${type}:${name}`, name, type, balance };
}

describe('groupByType', () => {
  const accounts: TreasuryAccount[] = [
    acct('caja', 'Caja POS 1', 10_000_000),
    acct('caja', 'Caja POS 2', 5_000_000),
    acct('caja_fuerte', 'Bóveda principal', 10_000_000),
    acct('banco', 'Bancolombia ahorros', 8_000_000),
    acct('banco', 'Nequi', 2_000_000),
  ];

  it('returns EFECTIVO leaves for caja and caja_fuerte accounts', () => {
    const tree = groupByType(accounts);

    expect(tree.efectivo).toHaveLength(3); // 2 cajas + 1 caja_fuerte
  });

  it('returns BANCOS leaves for banco accounts', () => {
    const tree = groupByType(accounts);

    expect(tree.bancos).toHaveLength(2);
  });

  it('each leaf preserves name and balance from source account', () => {
    const tree = groupByType(accounts);
    const fuerte = tree.efectivo.find(a => a.type === 'caja_fuerte');

    expect(fuerte?.name).toBe('Bóveda principal');
    expect(fuerte?.balance).toBe(10_000_000);
  });

  it('EFECTIVO subtotal equals sum of caja + caja_fuerte balances', () => {
    const tree = groupByType(accounts);
    const subtotal = tree.efectivo.reduce((acc, a) => acc + a.balance, 0);

    expect(subtotal).toBe(25_000_000);
  });

  it('BANCOS subtotal equals sum of banco balances', () => {
    const tree = groupByType(accounts);
    const subtotal = tree.bancos.reduce((acc, a) => acc + a.balance, 0);

    expect(subtotal).toBe(10_000_000);
  });

  it('returns empty branches for an empty account list', () => {
    const tree = groupByType([]);

    expect(tree.efectivo).toHaveLength(0);
    expect(tree.bancos).toHaveLength(0);
  });

  it('returns only bancos when no cash accounts exist', () => {
    const bancoOnly = [acct('banco', 'Bancolombia', 5_000)];
    const tree = groupByType(bancoOnly);

    expect(tree.efectivo).toHaveLength(0);
    expect(tree.bancos).toHaveLength(1);
  });

  it('returns only efectivo when no banco accounts exist', () => {
    const cashOnly = [acct('caja', 'Caja 1', 1_000), acct('caja_fuerte', 'Bóveda', 2_000)];
    const tree = groupByType(cashOnly);

    expect(tree.efectivo).toHaveLength(2);
    expect(tree.bancos).toHaveLength(0);
  });
});
