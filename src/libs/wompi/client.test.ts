import { describe, expect, it } from 'vitest';
import { buildCheckoutUrl, CHECKOUT_BASE } from './client';

describe('buildCheckoutUrl', () => {
  it('uses literal (unencoded) keys — signature:integrity keeps its colon', () => {
    const url = buildCheckoutUrl({
      publicKey: 'pub_test_abc',
      currency: 'COP',
      amountInCents: 2_490_000,
      reference: 'sk8-438k4-xmxm392-sn2m',
      signature:
        '37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5',
    });

    expect(url.startsWith(CHECKOUT_BASE)).toBe(true);
    expect(url).toContain('public-key=pub_test_abc');
    expect(url).toContain('currency=COP');
    expect(url).toContain('amount-in-cents=2490000');
    expect(url).toContain('reference=sk8-438k4-xmxm392-sn2m');
    expect(url).toContain(
      'signature:integrity=37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5',
    );
    // The colon in the key must NOT be percent-encoded.
    expect(url).not.toContain('signature%3Aintegrity');
  });

  it('percent-encodes values that need it (e.g. redirect-url)', () => {
    const url = buildCheckoutUrl({
      publicKey: 'pub',
      currency: 'COP',
      amountInCents: 100,
      reference: 'r&ef',
      signature: 's',
      redirectUrl: 'https://example.com/x?a=1&b=2',
    });

    expect(url).toContain('reference=r%26ef');
    expect(url).toContain(
      `redirect-url=${encodeURIComponent('https://example.com/x?a=1&b=2')}`,
    );
  });

  it('omits redirect-url when not provided', () => {
    const url = buildCheckoutUrl({
      publicKey: 'pub',
      currency: 'COP',
      amountInCents: 100,
      reference: 'r',
      signature: 's',
    });

    expect(url).not.toContain('redirect-url');
  });
});
