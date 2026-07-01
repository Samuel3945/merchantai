import type { Candidate } from './ranking';
import { describe, expect, it } from 'vitest';
import { rankAndDecide } from './ranking';

let seq = 0;

function makeCandidate(overrides: Partial<Candidate> & Pick<Candidate, 'name'>): Candidate {
  seq += 1;
  return {
    id: `cand-${seq}`,
    price: '1000.00',
    stock: 10,
    category: null,
    unitType: 'unit',
    barcode: null,
    sim: 0,
    ftsRank: 0,
    ...overrides,
  };
}

function names(items: { name: string }[]): string[] {
  return items.map(item => item.name);
}

describe('rankAndDecide', () => {
  it('"pan" matches "Pan tajado" (strong, token match) and rejects "Panela" (short query, no fuzzy fallback)', () => {
    const panTajado = makeCandidate({ name: 'Pan tajado', sim: 0.5, ftsRank: 0.2 });
    const panela = makeCandidate({ name: 'Panela', sim: 0.35, ftsRank: 0 });

    const res = rankAndDecide('pan', [panTajado, panela], 5);

    expect(names(res.results)).toContain('Pan tajado');
    expect(names(res.results)).not.toContain('Panela');
    expect(names(res.alternatives)).not.toContain('Panela');
    expect(res.status).toBe('exact_match');
  });

  it('"leche" matches "Leche entera" (strong) and rejects "Lechuga" everywhere', () => {
    const lecheEntera = makeCandidate({ name: 'Leche entera', sim: 0.6, ftsRank: 0.1 });
    const lechuga = makeCandidate({ name: 'Lechuga', sim: 0.4, ftsRank: 0 });

    const res = rankAndDecide('leche', [lecheEntera, lechuga], 5);

    expect(names(res.results)).toContain('Leche entera');
    expect(names(res.results)).not.toContain('Lechuga');
    expect(names(res.alternatives)).not.toContain('Lechuga');
  });

  it('"coca" matches "Coca Cola 1.5L" (strong) and rejects "Cocaína test" everywhere', () => {
    const cocaCola = makeCandidate({ name: 'Coca Cola 1.5L', sim: 0.5, ftsRank: 0.2 });
    const cocaina = makeCandidate({ name: 'Cocaína test', sim: 0.44, ftsRank: 0 });

    const res = rankAndDecide('coca', [cocaCola, cocaina], 5);

    expect(names(res.results)).toContain('Coca Cola 1.5L');
    expect(names(res.results)).not.toContain('Cocaína test');
    expect(names(res.alternatives)).not.toContain('Cocaína test');
  });

  it('"coca cola 2 litros" with no exact 2L: both presentations come back as alternatives, not results', () => {
    const cocaCola15 = makeCandidate({ name: 'Coca Cola 1.5L', sim: 0.6, ftsRank: 0.2 });
    const cocaCola3 = makeCandidate({ name: 'Coca Cola 3L', sim: 0.55, ftsRank: 0.15 });

    const res = rankAndDecide('coca cola 2 litros', [cocaCola15, cocaCola3], 5);

    expect(res.status).toBe('no_match_with_alternatives');
    expect(res.results).toEqual([]);
    expect(names(res.alternatives)).toEqual(
      expect.arrayContaining(['Coca Cola 1.5L', 'Coca Cola 3L']),
    );

    for (const alt of res.alternatives) {
      expect(alt.reason).toBe('other_presentation');
    }
  });

  it('"coca" with two strong matches → multiple_matches with clarification options', () => {
    const cocaCola15 = makeCandidate({ name: 'Coca Cola 1.5L', sim: 0.5, ftsRank: 0.2 });
    const cocaCola3 = makeCandidate({ name: 'Coca Cola 3L', sim: 0.5, ftsRank: 0.2 });

    const res = rankAndDecide('coca', [cocaCola15, cocaCola3], 5);

    expect(res.status).toBe('multiple_matches');
    expect(res.clarification.needed).toBe(true);
    expect(res.clarification.options).toEqual(
      expect.arrayContaining(['Coca Cola 1.5L', 'Coca Cola 3L']),
    );
  });

  it('ranks an in-stock strong match before an out-of-stock strong match, even with a lower score', () => {
    const outOfStock = makeCandidate({ id: 'out', name: 'Agua', stock: 0, sim: 0.09 });
    const inStock = makeCandidate({ id: 'in', name: 'Agua', stock: 5, sim: 0.01 });

    const res = rankAndDecide('agua', [outOfStock, inStock], 5);

    expect(res.results[0]!.id).toBe('in');
    expect(res.results[0]!.in_stock).toBe(true);
  });
});
