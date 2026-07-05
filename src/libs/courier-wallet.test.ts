import { describe, expect, it } from 'vitest';
import { computeCourierBalance } from '@/libs/courier-wallet';

describe('computeCourierBalance', () => {
  it('is zero for an empty ledger', () => {
    expect(computeCourierBalance([])).toBe(0);
  });

  it('adds base and collected sales, subtracts handovers', () => {
    const rows = [
      { direction: 'base_from_caja' as const, amount: '50000.00' },
      { direction: 'sale_collected' as const, amount: '12000.00' },
      { direction: 'sale_collected' as const, amount: '8000.00' },
      { direction: 'handover_to_caja' as const, amount: '40000.00' },
    ];

    // 50000 + 12000 + 8000 − 40000 = 30000
    expect(computeCourierBalance(rows)).toBe(30000);
  });

  it('can go negative if the courier handed over more than they hold (over-entrega)', () => {
    const rows = [
      { direction: 'base_from_caja' as const, amount: '10000.00' },
      { direction: 'handover_to_caja' as const, amount: '15000.00' },
    ];

    expect(computeCourierBalance(rows)).toBe(-5000);
  });

  it('keeps two-decimal precision', () => {
    const rows = [
      { direction: 'sale_collected' as const, amount: '0.10' },
      { direction: 'sale_collected' as const, amount: '0.20' },
    ];

    expect(computeCourierBalance(rows)).toBe(0.3);
  });
});
