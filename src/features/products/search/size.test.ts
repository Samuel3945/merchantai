import type { Candidate } from './ranking';
import { describe, expect, it } from 'vitest';
import { rankAndDecide } from './ranking';
import { parseSize, sizeDistance, sizeFromName } from './size';

describe('parseSize', () => {
  it('parses l/ml/kg/g into canonical base units', () => {
    expect(parseSize('coca cola 2l')).toEqual({ value: 2, unit: 'l', base: 2000, family: 'volume' });
    expect(parseSize('coca cola 1.5l')).toEqual({ value: 1.5, unit: 'l', base: 1500, family: 'volume' });
    expect(parseSize('agua 500ml')).toEqual({ value: 500, unit: 'ml', base: 500, family: 'volume' });
    expect(parseSize('arroz 500g')).toEqual({ value: 500, unit: 'g', base: 500, family: 'weight' });
    expect(parseSize('azucar 1kg')).toEqual({ value: 1, unit: 'kg', base: 1000, family: 'weight' });
  });

  it('returns null when there is no size token', () => {
    expect(parseSize('pan tajado')).toBeNull();
    expect(parseSize('coca cola')).toBeNull();
  });

  it('sizeDistance compares within a family, Infinity across families or when missing', () => {
    expect(sizeDistance(parseSize('2l'), parseSize('1.5l'))).toBe(500);
    expect(sizeDistance(parseSize('2l'), parseSize('1500ml'))).toBe(500);
    expect(sizeDistance(parseSize('2l'), parseSize('500g'))).toBe(Number.POSITIVE_INFINITY);
    expect(sizeDistance(null, parseSize('2l'))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('sizeFromName', () => {
  it('parses a size straight from a raw (non-normalized) product name', () => {
    expect(sizeFromName('Coca Cola 2 Litros')).toEqual({ value: 2, unit: 'l', base: 2000, family: 'volume' });
    expect(sizeFromName('Arroz Diana 500g')).toEqual({ value: 500, unit: 'g', base: 500, family: 'weight' });
  });

  it('returns null when the name has no size token', () => {
    expect(sizeFromName('Pan tajado')).toBeNull();
  });
});

let seq = 0;
function cand(name: string, sim: number, ftsRank: number, stock = 10): Candidate {
  seq += 1;
  return {
    id: `c-${seq}`,
    name,
    price: '1000.00',
    stock,
    category: null,
    unitType: 'unit',
    barcode: null,
    sim,
    ftsRank,
  };
}

describe('rankAndDecide — size-aware ordering', () => {
  it('for "coca cola 2 litros" offers the nearest size first (1.5L before 3L), beating raw score', () => {
    // 3L is given the HIGHER score on purpose; size proximity must still win.
    const c3 = cand('Coca Cola 3L', 0.6, 0.2);
    const c15 = cand('Coca Cola 1.5L', 0.5, 0.15);

    const res = rankAndDecide('coca cola 2 litros', [c3, c15], 5);

    expect(res.status).toBe('no_match_with_alternatives');
    expect(res.alternatives.map(a => a.name)).toEqual(['Coca Cola 1.5L', 'Coca Cola 3L']);
    expect(res.alternatives[0]!.size).toEqual({ value: 1.5, unit: 'l' });
    expect(res.alternatives[0]!.reason).toBe('other_presentation');
  });

  it('a query without a size keeps score-based ordering (no size tiebreaker)', () => {
    const cheap = cand('Coca Cola 1.5L', 0.5, 0.3);
    const other = cand('Coca Cola 3L', 0.5, 0.1);

    const res = rankAndDecide('coca cola', [cheap, other], 5);

    expect(res.status).toBe('multiple_matches');
    expect(res.results[0]!.name).toBe('Coca Cola 1.5L');
  });
});
