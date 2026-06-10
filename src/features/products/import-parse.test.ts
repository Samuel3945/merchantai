import { describe, expect, it } from 'vitest';
import {
  mapHeaderToField,
  recordsToDrafts,
  validateDraft,
} from './import-parse';

describe('mapHeaderToField', () => {
  it('maps Spanish/English headers, accent- and case-insensitively', () => {
    expect(mapHeaderToField('Nombre')).toBe('name');
    expect(mapHeaderToField('PRODUCTO')).toBe('name');
    expect(mapHeaderToField('Categoría')).toBe('category'); // accent stripped
    expect(mapHeaderToField('Precio de venta')).toBe('price');
    expect(mapHeaderToField('Código de barras')).toBe('barcode');
    expect(mapHeaderToField('unknown column')).toBeNull();
  });
});

describe('recordsToDrafts', () => {
  it('maps recognized columns and drops fully-empty rows', () => {
    const drafts = recordsToDrafts([
      { Nombre: 'Coca-Cola', Precio: '3000', Categoría: 'Bebidas', extra: 'x' },
      { Nombre: '  ', Precio: '', Categoría: '' }, // empty -> dropped
      { 'Producto': 'Pan', 'Precio de venta': '1500', 'Costo': '900' },
    ]);

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      name: 'Coca-Cola',
      price: '3000',
      category: 'Bebidas',
      barcode: '',
      cost: '',
    });
    expect(drafts[1]).toMatchObject({ name: 'Pan', price: '1500', cost: '900' });
  });
});

describe('validateDraft', () => {
  const base = { id: 'r', name: 'X', barcode: '', price: '100', cost: '', category: '' };

  it('passes a valid row', () => {
    expect(validateDraft(base)).toEqual([]);
  });

  it('flags a missing name', () => {
    expect(validateDraft({ ...base, name: '  ' })).toContain('Falta el nombre');
  });

  it('flags a non-numeric price', () => {
    expect(validateDraft({ ...base, price: 'abc' })).toContain('Precio inválido');
  });

  it('flags a bad cost only when present', () => {
    expect(validateDraft({ ...base, cost: '' })).toEqual([]);
    expect(validateDraft({ ...base, cost: '1.999' })).toContain('Costo inválido');
  });
});
