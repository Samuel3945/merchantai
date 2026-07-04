import { createHash, randomBytes } from 'node:crypto';
import { Env } from '@/libs/Env';

// Per-person POS PIN activation (Option B). Shared between the admin
// send-activation server action and the public /api/pos/cashiers/activate route
// so token generation, hashing and link building never drift apart.

// The link stays valid for 72h after the admin sends it.
export const ACTIVATION_TTL_HOURS = 72;
export const ACTIVATION_TTL_MS = ACTIVATION_TTL_HOURS * 60 * 60 * 1000;

// Primary production POS origin — the fallback when POS_WEB_URL is unset. Kept in
// sync with POS_ALLOWED_ORIGINS[0] in proxy.ts.
const DEFAULT_POS_WEB_URL = 'https://app.pos.mymerchantai.com';

/** A cryptographically-random one-time token, URL-safe (base64url, 32 bytes). */
export function generateActivationToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hash of the raw token, hex-encoded. Deterministic so the row can be
 * found by equality, while a DB leak can't be replayed (the raw token lives only
 * inside the link we send). 256-bit token entropy makes guessing infeasible.
 */
export function hashActivationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Builds the activation link the employee opens to set their own PIN. */
export function buildActivationUrl(rawToken: string): string {
  const base = (Env.POS_WEB_URL ?? DEFAULT_POS_WEB_URL).replace(/\/+$/, '');
  return `${base}/activar?token=${encodeURIComponent(rawToken)}`;
}
