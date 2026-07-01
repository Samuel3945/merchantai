import { describe, expect, it } from 'vitest';
import {
  CANCEL_REASON_KEYS,
  CANCEL_REASON_MESSAGES,
  CANCEL_REASONS,
  cancelReasonCustomerMessage,
  cancelReasonEventNote,
  isCancelReasonKey,
} from './cancellation-reasons';

describe('cancellation-reasons', () => {
  it('every key has a label, a customer message, and a UI entry', () => {
    for (const key of CANCEL_REASON_KEYS) {
      expect(CANCEL_REASON_MESSAGES[key]).toBeTruthy();
      expect(CANCEL_REASONS.some(r => r.key === key)).toBe(true);
    }

    expect(CANCEL_REASONS).toHaveLength(CANCEL_REASON_KEYS.length);
  });

  it('isCancelReasonKey guards unknown values', () => {
    expect(isCancelReasonKey('sin_stock')).toBe(true);
    expect(isCancelReasonKey('nope')).toBe(false);
    expect(isCancelReasonKey(undefined)).toBe(false);
  });

  it('event note is the label, and appends free text', () => {
    expect(cancelReasonEventNote('sin_stock')).toBe('Sin stock');
    expect(cancelReasonEventNote('otro', 'se cayó la moto')).toBe(
      'Otro motivo — se cayó la moto',
    );
    // Whitespace-only free text is ignored.
    expect(cancelReasonEventNote('otro', '   ')).toBe('Otro motivo');
  });

  it('customer message is reason-specific with a safe fallback', () => {
    expect(cancelReasonCustomerMessage('sin_stock')).toBe(
      CANCEL_REASON_MESSAGES.sin_stock,
    );
    expect(cancelReasonCustomerMessage('unknown')).toBe(
      CANCEL_REASON_MESSAGES.otro,
    );
  });
});
