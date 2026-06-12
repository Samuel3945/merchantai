import { describe, expect, it } from 'vitest';
import { parseWholesaleTiers, wholesaleUnitPrice } from './wholesale';

const TIERS = [
  { minQty: 6, price: '900' },
  { minQty: 12, price: '800' },
];

describe('parseWholesaleTiers', () => {
  it('parses the stored camelCase shape', () => {
    expect(parseWholesaleTiers(TIERS)).toEqual([
      { minQty: 6, price: 900 },
      { minQty: 12, price: 800 },
    ]);
  });

  it('accepts the snake_case wire shape', () => {
    expect(parseWholesaleTiers([{ min_qty: 6, price: 900 }])).toEqual([
      { minQty: 6, price: 900 },
    ]);
  });

  it('drops malformed entries and non-arrays', () => {
    expect(parseWholesaleTiers(null)).toEqual([]);
    expect(parseWholesaleTiers('nope')).toEqual([]);
    expect(
      parseWholesaleTiers([{ minQty: 1, price: 900 }, { minQty: 6, price: 0 }, 42]),
    ).toEqual([]);
  });

  it('sorts tiers by minQty ascending', () => {
    expect(
      parseWholesaleTiers([
        { minQty: 12, price: 800 },
        { minQty: 6, price: 900 },
      ]),
    ).toEqual([
      { minQty: 6, price: 900 },
      { minQty: 12, price: 800 },
    ]);
  });
});

describe('wholesaleUnitPrice', () => {
  it('returns base price below the first tier', () => {
    expect(wholesaleUnitPrice(1000, true, TIERS, 5)).toBe(1000);
  });

  it('applies the best tier the quantity qualifies for', () => {
    expect(wholesaleUnitPrice(1000, true, TIERS, 6)).toBe(900);
    expect(wholesaleUnitPrice(1000, true, TIERS, 11)).toBe(900);
    expect(wholesaleUnitPrice(1000, true, TIERS, 12)).toBe(800);
    expect(wholesaleUnitPrice(1000, true, TIERS, 100)).toBe(800);
  });

  it('ignores tiers when wholesale is disabled', () => {
    expect(wholesaleUnitPrice(1000, false, TIERS, 50)).toBe(1000);
  });

  it('returns base price when tiers are missing or invalid', () => {
    expect(wholesaleUnitPrice(1000, true, null, 50)).toBe(1000);
    expect(wholesaleUnitPrice(1000, true, [], 50)).toBe(1000);
  });
});
