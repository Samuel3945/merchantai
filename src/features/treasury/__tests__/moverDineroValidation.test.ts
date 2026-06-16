import { describe, expect, it } from 'vitest';
import { validateMoverDinero } from '../moverDineroValidation';

describe('validateMoverDinero', () => {
  it('returns error when origen and destino are the same', () => {
    const result = validateMoverDinero({ fromId: 'abc', toId: 'abc', amount: '500' });

    expect(result).not.toBeNull();
    expect(result).toMatch(/diferente/i);
  });

  it('returns error when amount is zero', () => {
    const result = validateMoverDinero({ fromId: 'abc', toId: 'xyz', amount: '0' });

    expect(result).not.toBeNull();
    expect(result).toMatch(/mayor/i);
  });

  it('returns error when amount is negative', () => {
    const result = validateMoverDinero({ fromId: 'abc', toId: 'xyz', amount: '-100' });

    expect(result).not.toBeNull();
    expect(result).toMatch(/mayor/i);
  });

  it('returns error when amount is not a valid number', () => {
    const result = validateMoverDinero({ fromId: 'abc', toId: 'xyz', amount: 'abc' });

    expect(result).not.toBeNull();
    expect(result).toMatch(/mayor/i);
  });

  it('returns error when fromId is empty', () => {
    const result = validateMoverDinero({ fromId: '', toId: 'xyz', amount: '500' });

    expect(result).not.toBeNull();
    expect(result).toMatch(/origen/i);
  });

  it('returns error when toId is empty', () => {
    const result = validateMoverDinero({ fromId: 'abc', toId: '', amount: '500' });

    expect(result).not.toBeNull();
    expect(result).toMatch(/destino/i);
  });

  it('returns null (valid) when all fields are correct with distinct locations', () => {
    const result = validateMoverDinero({ fromId: 'abc', toId: 'xyz', amount: '500' });

    expect(result).toBeNull();
  });

  it('returns null (valid) for a positive decimal amount', () => {
    const result = validateMoverDinero({ fromId: 'a', toId: 'b', amount: '0.01' });

    expect(result).toBeNull();
  });
});
