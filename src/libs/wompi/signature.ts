import { createHash } from 'node:crypto';

export type IntegritySignatureInput = {
  reference: string;
  amountInCents: number;
  currency: string;
  integritySecret: string;
  // Only included in the concatenation when the checkout link carries an
  // expiration (`expiration-time` form field).
  expirationTime?: string;
};

// Wompi Web Checkout integrity signature. Plain SHA256 hex — NOT HMAC — of
// reference + amountInCents + currency + [expirationTime] + integritySecret,
// concatenated in exactly that order (docs.wompi.co/docs/colombia/widget-checkout-web).
export function integritySignature({
  reference,
  amountInCents,
  currency,
  integritySecret,
  expirationTime,
}: IntegritySignatureInput): string {
  const base = expirationTime
    ? `${reference}${amountInCents}${currency}${expirationTime}${integritySecret}`
    : `${reference}${amountInCents}${currency}${integritySecret}`;
  return createHash('sha256').update(base).digest('hex');
}
