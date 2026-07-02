import { describe, expect, it } from 'vitest';
import { DEFAULT_TOPUP_PACKAGES, findPackage } from './topup-catalog';

describe('DEFAULT_TOPUP_PACKAGES / findPackage', () => {
  it('finds a known package with the right price', () => {
    const pkg = findPackage(DEFAULT_TOPUP_PACKAGES, 'credits_500');

    expect(pkg).toEqual({ id: 'credits_500', requests: 500, amountCop: 79_000 });
  });

  it('returns undefined for a bogus package id', () => {
    expect(findPackage(DEFAULT_TOPUP_PACKAGES, 'bogus')).toBeUndefined();
  });

  it('has exactly 3 default packages', () => {
    expect(DEFAULT_TOPUP_PACKAGES).toHaveLength(3);
  });
});
