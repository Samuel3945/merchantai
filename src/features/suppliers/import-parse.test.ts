import { describe, expect, it } from 'vitest';
import {
  mapHeaderToField,
  recordsToDrafts,
  validateDraft,
} from './import-parse';

describe('mapHeaderToField', () => {
  it('maps Spanish/English headers, accent- and case-insensitively', () => {
    expect(mapHeaderToField('Nombre')).toBe('name');
    expect(mapHeaderToField('PROVEEDOR')).toBe('name');
    expect(mapHeaderToField('Teléfono')).toBe('phone'); // accent stripped
    expect(mapHeaderToField('Correo electrónico')).toBe('email');
    expect(mapHeaderToField('Ciudad')).toBe('city');
    expect(mapHeaderToField('NIT')).toBe('taxId');
    expect(mapHeaderToField('unknown column')).toBeNull();
  });
});

describe('recordsToDrafts', () => {
  it('maps recognized columns and drops fully-empty rows', () => {
    const drafts = recordsToDrafts([
      { Nombre: 'Distribuidora Sur', Teléfono: '3001234567', Ciudad: 'Bogotá', extra: 'x' },
      { Nombre: '  ', Teléfono: '', Correo: '' }, // empty -> dropped
      { Proveedor: 'Lácteos El Prado', Correo: 'ventas@prado.co', NIT: '900123' },
    ]);

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      name: 'Distribuidora Sur',
      phone: '3001234567',
      city: 'Bogotá',
      email: '',
      taxId: '',
    });
    expect(drafts[1]).toMatchObject({
      name: 'Lácteos El Prado',
      email: 'ventas@prado.co',
      taxId: '900123',
    });
  });
});

describe('validateDraft', () => {
  const base = { id: 'r', name: 'Proveedor X', phone: '3001234567', email: '', city: '', taxId: '' };

  it('passes a valid row', () => {
    expect(validateDraft(base)).toEqual([]);
  });

  it('flags a missing name', () => {
    expect(validateDraft({ ...base, name: '  ' })).toContain('Falta el nombre');
  });

  it('requires a phone or an email', () => {
    expect(validateDraft({ ...base, phone: '', email: '' })).toContain(
      'Falta teléfono o correo',
    );
    expect(validateDraft({ ...base, phone: '', email: 'a@b.co' })).toEqual([]);
  });

  it('flags a malformed email only when present', () => {
    expect(validateDraft({ ...base, email: '' })).toEqual([]);
    expect(validateDraft({ ...base, phone: '', email: 'not-an-email' })).toContain(
      'Correo inválido',
    );
  });
});
