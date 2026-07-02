import { describe, expect, it } from 'vitest';
import { findPackage, TOPUP_CATALOG } from './topup-catalog';

describe('TOPUP_CATALOG / findPackage', () => {
  it('finds a known package with the right price', () => {
    const pkg = findPackage('credits_500');

    expect(pkg).toEqual({ id: 'credits_500', requests: 500, amountCop: 79_000 });
  });

  it('returns undefined for a bogus package id', () => {
    expect(findPackage('bogus')).toBeUndefined();
  });

  it('has exactly 3 packages', () => {
    expect(TOPUP_CATALOG).toHaveLength(3);
  });
});
