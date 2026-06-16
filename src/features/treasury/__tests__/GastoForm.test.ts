import { describe, expect, it } from 'vitest';
import { validateGasto } from '../gastoValidation';

describe('validateGasto', () => {
  it('returns error when fromAccountId is missing', () => {
    const result = validateGasto({
      fromAccountId: '',
      amount: '100',
      category: 'servicios',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/desde|origen|contenedor/i);
  });

  it('returns error when amount is zero', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '0',
      category: 'servicios',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/mayor/i);
  });

  it('returns error when amount is negative', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '-50',
      category: 'servicios',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/mayor/i);
  });

  it('returns error when amount is not a valid number', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: 'abc',
      category: 'servicios',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/mayor/i);
  });

  it('returns error when category is empty', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: '',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/categoría|categoria/i);
  });

  it('returns error when category is only whitespace', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: '   ',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/categoría|categoria/i);
  });

  it('returns null when all required fields are valid', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'servicios',
    });

    expect(result).toBeNull();
  });

  it('returns null for a positive decimal amount', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '0.01',
      category: 'otros',
    });

    expect(result).toBeNull();
  });
});
