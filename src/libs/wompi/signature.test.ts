import { describe, expect, it } from 'vitest';
import { integritySignature } from './signature';

// Known-answer vector from docs.wompi.co/docs/colombia/widget-checkout-web —
// the exact worked example used to explain the Web Checkout integrity
// signature. Verified independently (plain SHA256, not HMAC).
describe('integritySignature', () => {
  it('matches the documented known-answer vector (no expirationTime)', () => {
    const hash = integritySignature({
      reference: 'sk8-438k4-xmxm392-sn2m',
      amountInCents: 2490000,
      currency: 'COP',
      integritySecret: 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6',
    });

    expect(hash).toBe(
      '37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5',
    );
  });

  it('produces a different (and still valid) hash when expirationTime is included', () => {
    const base = {
      reference: 'ref-1',
      amountInCents: 10_000,
      currency: 'COP',
      integritySecret: 'test-secret',
    };

    const withoutExpiration = integritySignature(base);
    const withExpiration = integritySignature({
      ...base,
      expirationTime: '2026-12-31T23:59:59.000Z',
    });

    expect(withExpiration).not.toBe(withoutExpiration);
    expect(withExpiration).toMatch(/^[0-9a-f]{64}$/);
    expect(withoutExpiration).toMatch(/^[0-9a-f]{64}$/);
  });
});
