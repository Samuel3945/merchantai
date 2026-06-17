// Pure, dependency-free resolution of a sale's BUSINESS time (occurred_at).
//
// created_at is the server insert time; occurred_at is when the sale actually
// happened. On the always-online web POS the client sends nothing and the two
// coincide. The field exists so a future offline-capable client can ship the
// real timestamp of a queued sale and have analytics measure on it instead of
// sync time. We TRUST that client time only within sane bounds: a device whose
// clock is far ahead, or absurdly behind, must not poison the data, so we clamp
// back to `now`.

export type OccurredAtBounds = {
  /** How far ahead of the server a client clock may be before we distrust it. */
  maxFutureSkewMs: number;
  /** Oldest a client timestamp may be (a real offline backlog, not a dead clock). */
  maxPastMs: number;
};

export const DEFAULT_OCCURRED_AT_BOUNDS: OccurredAtBounds = {
  maxFutureSkewMs: 2 * 60_000, // 2 minutes of tolerated clock skew
  maxPastMs: 2 * 24 * 60 * 60_000, // 2 days of tolerated offline backlog
};

export function resolveOccurredAt(
  clientISO: string | null | undefined,
  now: Date,
  bounds: OccurredAtBounds = DEFAULT_OCCURRED_AT_BOUNDS,
): Date {
  if (!clientISO) {
    return now;
  }

  const candidate = new Date(clientISO);
  if (Number.isNaN(candidate.getTime())) {
    return now;
  }

  const delta = candidate.getTime() - now.getTime();
  if (delta > bounds.maxFutureSkewMs || -delta > bounds.maxPastMs) {
    return now;
  }

  return candidate;
}
