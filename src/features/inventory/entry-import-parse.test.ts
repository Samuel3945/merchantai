import { describe, expect, it } from 'vitest';
import {
  buildMatchIndex,
  mapHeaderToField,
  matchProduct,
  recordsToEntryDrafts,
  validateEntryDraft,
} from './entry-import-parse';

const targets = [
  { id: 'p1', name: 'Coca-Cola 600ml', barcode: '7702004001234', cost: '2100' },
  { id: 'p2', name: 'Pan tajado', barcode: null, cost: '1800' },
  { id: 'p3', name: 'Café', barcode: '111', cost: '0' },
];

describe('mapHeaderToField', () => {
  it('maps Spanish/English headers, accent- and case-insensitively', () => {
    expect(mapHeaderToField('Nombre')).toBe('name');
    expect(mapHeaderToField('PRODUCTO')).toBe('name');
    expect(mapHeaderToField('Código de barras')).toBe('barcode'); // accent stripped
    expect(mapHeaderToField('Cantidad')).toBe('qty');
    expect(mapHeaderToField('Costo unitario')).toBe('cost');
    expect(mapHeaderToField('Vencimiento')).toBe('expires');
    expect(mapHeaderToField('unknown column')).toBeNull();
  });
});

describe('matchProduct', () => {
  const index = buildMatchIndex(targets);

  it('matches by barcode first', () => {
    expect(matchProduct('7702004001234', 'whatever', index)).toBe('p1');
  });

  it('falls back to name, accent- and case-insensitively', () => {
    expect(matchProduct('', 'pan tajado', index)).toBe('p2');
    expect(matchProduct('', 'CAFE', index)).toBe('p3'); // accent-insensitive
  });

  it('returns null when nothing resolves', () => {
    expect(matchProduct('999', 'Producto fantasma', index)).toBeNull();
  });
});

describe('recordsToEntryDrafts', () => {
  it('matches rows and pre-fills cost from the product when blank', () => {
    const drafts = recordsToEntryDrafts(
      [
        { 'codigo de barras': '7702004001234', 'cantidad': '24' }, // cost blank
        { nombre: 'Pan tajado', cantidad: '12', costo: '2000' }, // cost kept
        { nombre: '', cantidad: '' }, // empty -> dropped
      ],
      targets,
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ productId: 'p1', qty: '24', unitCost: '2100' });
    expect(drafts[1]).toMatchObject({ productId: 'p2', qty: '12', unitCost: '2000' });
  });

  it('leaves productId null and keeps the raw label when unmatched', () => {
    const drafts = recordsToEntryDrafts(
      [{ nombre: 'Producto fantasma', cantidad: '5', costo: '100' }],
      targets,
    );

    expect(drafts[0]).toMatchObject({
      productId: null,
      label: 'Producto fantasma',
      qty: '5',
    });
  });
});

describe('validateEntryDraft', () => {
  const base = {
    id: 'r',
    productId: 'p1',
    label: 'Coca',
    qty: '5',
    unitCost: '2100',
    expiresAt: '',
  };
  const notPerishable = () => false;

  it('passes a valid row', () => {
    expect(validateEntryDraft(base, notPerishable)).toEqual([]);
  });

  it('flags a row with no product selected', () => {
    expect(validateEntryDraft({ ...base, productId: null }, notPerishable))
      .toContain('Elegí un producto');
  });

  it('flags a non-positive or non-integer quantity', () => {
    expect(validateEntryDraft({ ...base, qty: '0' }, notPerishable))
      .toContain('Cantidad inválida');
    expect(validateEntryDraft({ ...base, qty: '1.5' }, notPerishable))
      .toContain('Cantidad inválida');
  });

  it('requires a cost greater than zero', () => {
    expect(validateEntryDraft({ ...base, unitCost: '' }, notPerishable))
      .toContain('Costo inválido');
    expect(validateEntryDraft({ ...base, unitCost: '0' }, notPerishable))
      .toContain('Costo inválido');
  });

  it('requires an expiry only for perishable products', () => {
    const perishable = () => true;

    expect(validateEntryDraft(base, perishable)).toContain('Falta vencimiento');
    expect(validateEntryDraft({ ...base, expiresAt: '2026-12-31' }, perishable))
      .toEqual([]);
  });
});
