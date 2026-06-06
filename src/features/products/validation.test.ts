import { describe, expect, it } from 'vitest';
import { productCreateSchema } from './validation';

const base = { name: 'Café', price: '1000' };

describe('productCreateSchema', () => {
  it('accepts a minimal product', () => {
    const r = productCreateSchema.safeParse(base);

    expect(r.success).toBe(true);
  });

  it('requires a unit cost when opening stock is provided', () => {
    const r = productCreateSchema.safeParse({ ...base, initialQty: 5 });

    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => i.path.includes('initialCost'))).toBe(true);
  });

  it('accepts opening stock with a cost', () => {
    const r = productCreateSchema.safeParse({ ...base, initialQty: 5, initialCost: '500' });

    expect(r.success).toBe(true);
  });

  it('requires an expiry date for perishable opening stock', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isPerishable: true,
      initialQty: 5,
      initialCost: '500',
    });

    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => i.path.includes('initialExpiresAt'))).toBe(true);
  });

  it('accepts perishable opening stock with an expiry', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isPerishable: true,
      initialQty: 5,
      initialCost: '500',
      initialExpiresAt: '2030-01-01',
    });

    expect(r.success).toBe(true);
  });

  it('rejects a wholesale tier priced at or above the base price', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isWholesale: true,
      wholesaleTiers: [{ minQty: 10, price: '1000' }],
    });

    expect(r.success).toBe(false);
  });

  it('rejects non-increasing tier quantities', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isWholesale: true,
      wholesaleTiers: [
        { minQty: 10, price: '900' },
        { minQty: 10, price: '800' },
      ],
    });

    expect(r.success).toBe(false);
  });

  it('accepts well-formed decreasing wholesale tiers', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isWholesale: true,
      wholesaleTiers: [
        { minQty: 10, price: '900' },
        { minQty: 20, price: '800' },
      ],
    });

    expect(r.success).toBe(true);
  });

  it('requires a publish date when status is scheduled', () => {
    const r = productCreateSchema.safeParse({ ...base, status: 'scheduled' });

    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => i.path.includes('publishAt'))).toBe(true);
  });

  it('requires a duration when a warranty type is set', () => {
    const r = productCreateSchema.safeParse({ ...base, warrantyType: 'store' });

    expect(r.success).toBe(false);
    expect(
      r.error?.issues.some(i => i.path.includes('warrantyDurationDays')),
    ).toBe(true);
  });

  it('accepts a warranty with type and duration', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      warrantyType: 'store',
      warrantyDurationDays: 365,
    });

    expect(r.success).toBe(true);
  });

  it('accepts "none" warranty without a duration', () => {
    const r = productCreateSchema.safeParse({ ...base, warrantyType: 'none' });

    expect(r.success).toBe(true);
  });
});
