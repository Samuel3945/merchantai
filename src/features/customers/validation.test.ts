import { describe, expect, it } from 'vitest';
import { customerUpdateSchema } from './validation';

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
