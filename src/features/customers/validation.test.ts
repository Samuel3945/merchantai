import { describe, expect, it } from 'vitest';
import {
  customerUpdateSchema,
  isConsumidorFinal,
  parseFacturaCustomer,
} from './validation';

describe('customerUpdateSchema', () => {
  // Regression: editing a customer used to re-inject `marketingOptIn: true`
  // because Zod keeps a base `.default(true)` through `.partial()`. Combined
  // with the spread-if-defined update, that silently re-subscribed a customer
  // who had opted out. An edit that omits the field must leave it untouched.
  it('never produces marketingOptIn when omitted, so opt-out is preserved', () => {
    const r = customerUpdateSchema.parse({ name: 'Juan' });

    expect('marketingOptIn' in r).toBe(false);
    expect((r as Record<string, unknown>).marketingOptIn).toBeUndefined();
  });

  it('still honours an explicit marketingOptIn on edit', () => {
    const r = customerUpdateSchema.parse({ name: 'Juan', marketingOptIn: false });

    expect(r.marketingOptIn).toBe(false);
  });

  // totalSpent is an accumulator owned by sales — it must not be settable via
  // a customer edit, so the update schema drops it entirely.
  it('never produces totalSpent, so an edit cannot overwrite it', () => {
    const r = customerUpdateSchema.parse({ name: 'Juan', totalSpent: '999' });

    expect('totalSpent' in r).toBe(false);
    expect((r as Record<string, unknown>).totalSpent).toBeUndefined();
  });
});

describe('parseFacturaCustomer', () => {
  // Regression: the name capture used to run to end-of-line, swallowing the
  // phone and the [FACTURA] tag into the stored name, producing rows like
  // "KELLY TEJADA | Tel:3003507557 || [FACTURA] CONSUMIDOR_FINAL". The name
  // must stop at the first `|` field separator.
  it('captures only the name, not the trailing pipe-separated fields', () => {
    const parsed = parseFacturaCustomer(
      'Cliente: KELLY TEJADA | Tel:3003507557 || [FACTURA] CONSUMIDOR_FINAL',
    );

    expect(parsed?.name).toBe('KELLY TEJADA');
    expect(parsed?.whatsapp).toBe('3003507557');
  });

  it('parses a full [FACTURA] line into clean fields', () => {
    const parsed = parseFacturaCustomer(
      '[FACTURA] Nombre: Ana Gómez | Doc: 12345678 | WA: 3001112233',
    );

    expect(parsed?.name).toBe('Ana Gómez');
    expect(parsed?.documentId).toBe('12345678');
    expect(parsed?.whatsapp).toBe('3001112233');
  });

  it('returns null when there is no [FACTURA] tag', () => {
    expect(parseFacturaCustomer('Cliente: Ana | Tel: 3001112233')).toBeNull();
  });
});

describe('isConsumidorFinal', () => {
  // Regression: the canonical POS marker is `CONSUMIDOR_FINAL` (underscore).
  // The old /consumidor\s*final/ regex only matched whitespace, so the guard
  // that skips anonymous sales never fired for the real marker.
  it('recognises the underscore marker emitted by the POS', () => {
    expect(isConsumidorFinal('CONSUMIDOR_FINAL')).toBe(true);
  });

  it('still recognises the spaced and cased variants', () => {
    expect(isConsumidorFinal('Consumidor Final')).toBe(true);
    expect(isConsumidorFinal('consumidorfinal')).toBe(true);
  });

  it('is false for a real name', () => {
    expect(isConsumidorFinal('Kelly Tejada')).toBe(false);
  });
});
