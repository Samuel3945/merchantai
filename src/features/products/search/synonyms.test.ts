import type { Candidate } from './ranking';
import { describe, expect, it } from 'vitest';
import { rankAndDecide } from './ranking';
import { canonicalToken, expandQueries, synonymsOf } from './synonyms';

describe('synonyms', () => {
  it('canonicalToken maps variants to the canonical term, unknown → itself', () => {
    expect(canonicalToken('refresco')).toBe('gaseosa');
    expect(canonicalToken('papelon')).toBe('panela');
    expect(canonicalToken('coca')).toBe('coca');
  });

  it('synonymsOf returns the whole group', () => {
    expect(synonymsOf('gaseosa').sort()).toEqual(['gaseosa', 'refresco', 'soda'].sort());
    expect(synonymsOf('desconocido')).toEqual(['desconocido']);
  });

  it('expandQueries substitutes one token at a time', () => {
    const out = expandQueries('gaseosa cola');

    expect(out).toContain('gaseosa cola');
    expect(out).toContain('refresco cola');
    expect(out).toContain('soda cola');
  });
});

describe('rankAndDecide — synonym matching', () => {
  it('"gaseosa" strong-matches a "Refresco" product via canonicalized tokens', () => {
    const refresco: Candidate = {
      id: 'r1',
      name: 'Refresco Cola 1.5L',
      price: '2000.00',
      stock: 8,
      category: null,
      unitType: 'unit',
      barcode: null,
      sim: 0.1,
      ftsRank: 0.2,
    };

    const res = rankAndDecide('gaseosa', [refresco], 5);

    expect(res.status).toBe('exact_match');
    expect(res.results.map(r => r.name)).toContain('Refresco Cola 1.5L');
    expect(res.results[0]!.match).toBe('strong');
  });
});
