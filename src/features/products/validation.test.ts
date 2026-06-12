import { describe, expect, it } from 'vitest';
import { productCreateSchema, productUpdateSchema } from './validation';

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

  it('accepts a digital product without a limit (unlimited)', () => {
    const r = productCreateSchema.safeParse({ ...base, isDigital: true });

    expect(r.success).toBe(true);
    expect(r.data?.digitalLimit).toBeUndefined();
  });

  it('accepts a digital product with a sales limit', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isDigital: true,
      digitalLimit: 50,
    });

    expect(r.success).toBe(true);
    expect(r.data?.digitalLimit).toBe(50);
  });

  it('keeps an explicit null digitalLimit as null (unlimited)', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isDigital: true,
      digitalLimit: null,
    });

    expect(r.success).toBe(true);
    expect(r.data?.digitalLimit).toBeNull();
  });

  it('rejects a digital product sold by weight', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isDigital: true,
      unitType: 'kg',
    });

    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => i.path.includes('unitType'))).toBe(true);
  });

  it('rejects a digital perishable product', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isDigital: true,
      isPerishable: true,
    });

    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => i.path.includes('isPerishable'))).toBe(true);
  });

  it('rejects opening stock on a digital product', () => {
    const r = productCreateSchema.safeParse({
      ...base,
      isDigital: true,
      initialQty: 5,
      initialCost: '500',
    });

    expect(r.success).toBe(false);
    expect(r.error?.issues.some(i => i.path.includes('initialQty'))).toBe(true);
  });
});

describe('productUpdateSchema', () => {
  // Regression: editing a product (e.g. toggling wholesale) used to wipe stock.
  // The edit form never sends `stock`, but Zod kept the base `.default(0)`
  // through `.partial()`, so the parsed payload carried `stock: 0` and the
  // update overwrote the product's real stock with zero. Stock is owned by
  // inventory movements — an edit must never produce a stock value.
  it('never produces a stock field, so an edit cannot overwrite stock', () => {
    const r = productUpdateSchema.parse({
      name: 'Café',
      price: '1000',
      isWholesale: true,
    });

    expect('stock' in r).toBe(false);
    expect((r as Record<string, unknown>).stock).toBeUndefined();
  });
});
