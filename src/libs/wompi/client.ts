import { Env } from '@/libs/Env';

// Same URL for sandbox and production — the public key's prefix
// (pub_test_/pub_prod_) decides the environment server-side.
export const CHECKOUT_BASE = 'https://checkout.wompi.co/p/';

export type BuildCheckoutUrlInput = {
  publicKey: string;
  currency: string;
  amountInCents: number;
  reference: string;
  signature: string;
  redirectUrl?: string;
};

// Builds the Wompi Web Checkout redirect URL. Query param KEYS are literal
// (not url-encoded) — in particular `signature:integrity` must keep its
// colon. Only VALUES are percent-encoded.
export function buildCheckoutUrl({
  publicKey,
  currency,
  amountInCents,
  reference,
  signature,
  redirectUrl,
}: BuildCheckoutUrlInput): string {
  const params: [string, string][] = [
    ['public-key', publicKey],
    ['currency', currency],
    ['amount-in-cents', String(amountInCents)],
    ['reference', reference],
    ['signature:integrity', signature],
  ];
  if (redirectUrl) {
    params.push(['redirect-url', redirectUrl]);
  }

  const query = params
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return `${CHECKOUT_BASE}?${query}`;
}

export type WompiTransaction = {
  id: string;
  status: string;
  reference: string;
  amountInCents: number;
  currency: string;
};

// Authoritative server-to-server transaction lookup — the source of truth for
// granting credits, over trusting the webhook body alone. Returns null on any
// non-200 response, network failure, or malformed body; callers fall back to
// the webhook's own reported status in that case.
export async function getTransaction(
  id: string,
): Promise<WompiTransaction | null> {
  try {
    const res = await fetch(`${Env.WOMPI_API_BASE_URL}/transactions/${id}`, {
      headers: { Authorization: `Bearer ${Env.WOMPI_PRIVATE_KEY}` },
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const data = body.data;
    if (
      !data
      || typeof data.id !== 'string'
      || typeof data.status !== 'string'
    ) {
      return null;
    }
    return {
      id: data.id,
      status: data.status,
      reference: typeof data.reference === 'string' ? data.reference : '',
      amountInCents:
        typeof data.amount_in_cents === 'number' ? data.amount_in_cents : 0,
      currency: typeof data.currency === 'string' ? data.currency : '',
    };
  } catch {
    return null;
  }
}
