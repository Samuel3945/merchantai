import { describe, expect, it } from 'vitest';
import {
  computeWarrantyEndsAt,
  hasWarranty,
  isWarrantyActive,
  snapshotWarranty,
  warrantyDurationLabel,
} from './warranty';

describe('hasWarranty', () => {
  it('is false for null / none / missing duration', () => {
    expect(hasWarranty({ warrantyType: null, warrantyDurationDays: null })).toBe(false);
    expect(hasWarranty({ warrantyType: 'none', warrantyDurationDays: 365 })).toBe(false);
    expect(hasWarranty({ warrantyType: 'store', warrantyDurationDays: null })).toBe(false);
    expect(hasWarranty({ warrantyType: 'store', warrantyDurationDays: 0 })).toBe(false);
  });

  it('is true for a real warranty', () => {
    expect(hasWarranty({ warrantyType: 'store', warrantyDurationDays: 90 })).toBe(true);
  });
});

describe('computeWarrantyEndsAt', () => {
  it('adds the duration in days to the start', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');

    expect(computeWarrantyEndsAt(start, 30).toISOString()).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });
});

describe('snapshotWarranty', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');

  it('returns nulls when the product has no warranty', () => {
    expect(snapshotWarranty({ warrantyType: 'none' }, start)).toEqual({
      warrantyType: null,
      warrantyDurationDays: null,
      warrantyEndsAt: null,
    });
  });

  it('freezes type, duration and computed end date', () => {
    const snap = snapshotWarranty(
      { warrantyType: 'manufacturer', warrantyDurationDays: 365 },
      start,
    );

    expect(snap.warrantyType).toBe('manufacturer');
    expect(snap.warrantyDurationDays).toBe(365);
    expect(snap.warrantyEndsAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('isWarrantyActive', () => {
  it('is false for null', () => {
    expect(isWarrantyActive(null)).toBe(false);
  });

  it('compares against now', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');

    expect(isWarrantyActive(new Date('2026-06-02T00:00:00.000Z'), now)).toBe(true);
    expect(isWarrantyActive(new Date('2026-05-31T00:00:00.000Z'), now)).toBe(false);
  });
});

describe('warrantyDurationLabel', () => {
  it('maps known presets and falls back to days', () => {
    expect(warrantyDurationLabel(365)).toBe('1 año');
    expect(warrantyDurationLabel(180)).toBe('6 meses');
    expect(warrantyDurationLabel(45)).toBe('45 días');
    expect(warrantyDurationLabel(null)).toBe('—');
  });
});
