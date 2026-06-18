import { describe, expect, it } from 'vitest';
import { TREASURY_EXPENSE_CATEGORIES, TREASURY_EXPENSE_CATEGORY_LABELS } from '../expenseCategories';
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
      description: 'some reason',
    });

    expect(result).toBeNull();
  });

  // ── REQ-4: 'otros' requires description ────────────────────────────────────

  it('returns error when category is "otros" and description is empty', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'otros',
      description: '',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/otros|motivo|descripci/i);
  });

  it('returns error when category is "otros" and description is only whitespace', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'otros',
      description: '   ',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/otros|motivo|descripci/i);
  });

  it('returns error when category is "otros" and description is absent', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'otros',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/otros|motivo|descripci/i);
  });

  it('returns null when category is "otros" with a non-empty description', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'otros',
      description: 'Gasto de emergencia',
    });

    expect(result).toBeNull();
  });

  it('returns null when category is not "otros" and description is absent', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'servicios',
    });

    expect(result).toBeNull();
  });

  // ── REQ-5: incurredOn date field ───────────────────────────────────────────

  it('returns error when incurredOn is not a valid date', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'servicios',
      incurredOn: 'not-a-date',
    });

    expect(result).not.toBeNull();
    expect(result).toMatch(/fecha/i);
  });

  it('returns null when incurredOn is a valid past date', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'servicios',
      incurredOn: '2026-01-15',
    });

    expect(result).toBeNull();
  });

  it('returns null when incurredOn is omitted (defaults to today)', () => {
    const result = validateGasto({
      fromAccountId: 'abc-123',
      amount: '100',
      category: 'servicios',
    });

    expect(result).toBeNull();
  });

  // ── TREASURY_EXPENSE_CATEGORIES shape ──────────────────────────────────────

  it('TREASURY_EXPENSE_CATEGORIES includes "otros"', () => {
    expect(TREASURY_EXPENSE_CATEGORIES).toContain('otros');
  });

  it('TREASURY_EXPENSE_CATEGORY_LABELS has a label for each category', () => {
    for (const cat of TREASURY_EXPENSE_CATEGORIES) {
      expect(TREASURY_EXPENSE_CATEGORY_LABELS[cat]).toBeTruthy();
    }
  });
});
