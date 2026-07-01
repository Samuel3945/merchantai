import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

export type WompiEventSignature = {
  properties: string[];
  checksum: string;
  // Wompi's real payload puts `timestamp` at the TOP LEVEL of the event (see
  // below). Kept optional here only as a defensive fallback in case a payload
  // variant ever carries it inside `signature` — the checksum then still
  // computes correctly regardless of where the timestamp lives.
  timestamp?: number;
};

// Shape of the body Wompi POSTs to the events webhook (e.g. `transaction.updated`).
//
// NOTE: `timestamp` is a TOP-LEVEL field, a sibling of `signature` — NOT
// nested inside `signature`. Verified directly against the live docs page
// (docs.wompi.co/docs/colombia/eventos); their own worked JSON example shows
// `timestamp` alongside `event`/`data`/`signature`/`sent_at`, not inside the
// `signature` object.
export type WompiEvent = {
  event: string;
  data: Record<string, unknown>;
  signature: WompiEventSignature;
  timestamp?: number;
  sent_at?: string;
  environment?: string;
};

// Resolves a dot-separated path ("transaction.id") against a nested object.
// Returns undefined if any segment along the way is missing or not an object.
export function resolveDotPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// SHA256 hex of: concat(values of signature.properties, resolved as dot-paths
// into `data`, in order) + String(timestamp) + eventsSecret.
export function computeEventChecksum(
  event: WompiEvent,
  eventsSecret: string,
): string {
  const values = event.signature.properties.map((prop) => {
    const value = resolveDotPath(event.data, prop);
    return value === null || value === undefined ? '' : String(value);
  });
  // Real Wompi payloads carry `timestamp` at the top level; fall back to a
  // signature-nested one so verification survives either shape.
  const timestamp = event.timestamp ?? event.signature?.timestamp;
  const base = `${values.join('')}${String(timestamp)}${eventsSecret}`;
  return createHash('sha256').update(base).digest('hex');
}

// Constant-time, case-insensitive comparison against the checksum Wompi sent
// (event.signature.checksum or the X-Event-Checksum header).
export function verifyEventChecksum(
  event: WompiEvent,
  eventsSecret: string,
  provided: string,
): boolean {
  const expectedHex = computeEventChecksum(event, eventsSecret).toLowerCase();
  const providedHex = provided.trim().toLowerCase();

  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(providedHex, 'hex');
  if (
    expected.length === 0
    || actual.length !== expected.length
    // Buffer.from(..., 'hex') silently truncates on invalid characters instead
    // of throwing — re-encoding and comparing the string catches that case.
    || actual.toString('hex') !== providedHex
  ) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
