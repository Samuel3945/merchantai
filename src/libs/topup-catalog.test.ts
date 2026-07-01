import { describe, expect, it } from 'vitest';
import { findPackage, TOPUP_CATALOG } from './topup-catalog';

describe('TOPUP_CATALOG / findPackage', () => {
  it('finds a known AI-agent package with the right price', () => {
    const pkg = findPackage('sales_manager', 'sales_manager_500');

    expect(pkg).toEqual({ id: 'sales_manager_500', requests: 500, amountCop: 79_000 });
  });

  it('prices einvoice packages at 50 COP per credit', () => {
    expect(findPackage('einvoice', 'einvoice_100')?.amountCop).toBe(5_000);
    expect(findPackage('einvoice', 'einvoice_500')?.amountCop).toBe(25_000);
    expect(findPackage('einvoice', 'einvoice_1000')?.amountCop).toBe(50_000);
  });

  it('returns undefined for a bogus package id', () => {
    expect(findPackage('sales_manager', 'bogus')).toBeUndefined();
  });

  it('returns undefined for a package id belonging to a different agent kind', () => {
    expect(findPackage('customer_service', 'sales_manager_500')).toBeUndefined();
  });

  it('every agent kind has exactly 3 packages', () => {
    expect(TOPUP_CATALOG.sales_manager).toHaveLength(3);
    expect(TOPUP_CATALOG.customer_service).toHaveLength(3);
    expect(TOPUP_CATALOG.einvoice).toHaveLength(3);
  });
});
