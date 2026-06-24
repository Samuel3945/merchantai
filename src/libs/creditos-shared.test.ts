import { describe, expect, it } from 'vitest';
import {
  daysUntilDue,
  deriveDueState,
  dueStateLabel,
} from '@/libs/creditos-shared';

// Noon UTC keeps the local calendar date stable across UTC and the Americas, so
// these day-difference assertions don't flake on the CI timezone.
const TODAY = new Date('2026-06-06T12:00:00Z');

describe('daysUntilDue', () => {
  it('counts days to a future due date', () => {
    expect(daysUntilDue('2026-06-10', TODAY)).toBe(4);
  });

  it('is 0 on the due date', () => {
    expect(daysUntilDue('2026-06-06', TODAY)).toBe(0);
  });

  it('is negative when overdue', () => {
    expect(daysUntilDue('2026-06-01', TODAY)).toBe(-5);
  });
});

describe('deriveDueState', () => {
  it('past due -> overdue', () => {
    expect(deriveDueState('2026-06-01', false, TODAY)).toEqual({
      state: 'overdue',
      days: -5,
    });
  });

  it('due today -> due_soon', () => {
    expect(deriveDueState('2026-06-06', false, TODAY).state).toBe('due_soon');
  });

  it('within the warning window -> due_soon', () => {
    expect(deriveDueState('2026-06-08', false, TODAY).state).toBe('due_soon');
  });

  it('comfortably ahead -> on_track', () => {
    expect(deriveDueState('2026-06-20', false, TODAY).state).toBe('on_track');
  });

  it('paid short-circuits regardless of date', () => {
    expect(deriveDueState('2026-06-01', true, TODAY)).toEqual({
      state: 'paid',
      days: 0,
    });
  });
});

describe('dueStateLabel', () => {
  it('overdue shows days late', () => {
    expect(dueStateLabel('overdue', -8)).toBe('Atrasado 8 días');
  });

  it('due tomorrow / today', () => {
    expect(dueStateLabel('due_soon', 1)).toBe('Vence mañana');
    expect(dueStateLabel('due_soon', 0)).toBe('Vence hoy');
  });

  it('on track shows days remaining', () => {
    expect(dueStateLabel('on_track', 12)).toBe('Vence en 12 días');
  });

  it('paid', () => {
    expect(dueStateLabel('paid', 0)).toBe('Pagado');
  });
});
