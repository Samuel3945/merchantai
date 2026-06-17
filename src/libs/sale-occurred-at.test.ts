import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OCCURRED_AT_BOUNDS,
  resolveOccurredAt,
} from '@/libs/sale-occurred-at';

// Pure clamp for a sale's business time. The web POS is always online so it
// sends nothing and we fall back to `now`. The field exists for a future
// offline-capable client: it may ship a real past timestamp, which we TRUST
// within sane bounds and otherwise reject to `now` (a broken device clock must
// not poison analytics).

const NOW = new Date('2026-06-17T12:00:00.000Z');

describe('resolveOccurredAt', () => {
  it('falls back to now when no client time is given', () => {
    expect(resolveOccurredAt(undefined, NOW)).toEqual(NOW);
    expect(resolveOccurredAt(null, NOW)).toEqual(NOW);
    expect(resolveOccurredAt('', NOW)).toEqual(NOW);
  });

  it('falls back to now on an unparseable timestamp', () => {
    expect(resolveOccurredAt('not-a-date', NOW)).toEqual(NOW);
  });

  it('trusts a client time within the skew/backlog window', () => {
    const justBefore = new Date(NOW.getTime() - 60_000); // 1 min ago

    expect(resolveOccurredAt(justBefore.toISOString(), NOW)).toEqual(justBefore);

    const hoursAgo = new Date(NOW.getTime() - 3 * 60 * 60_000); // offline backlog

    expect(resolveOccurredAt(hoursAgo.toISOString(), NOW)).toEqual(hoursAgo);
  });

  it('rejects a clock that is ahead beyond the skew tolerance', () => {
    const future = new Date(NOW.getTime() + 5 * 60_000); // 5 min ahead

    expect(resolveOccurredAt(future.toISOString(), NOW)).toEqual(NOW);
  });

  it('accepts a tiny forward skew (within tolerance)', () => {
    const slightlyAhead = new Date(NOW.getTime() + 60_000); // 1 min ahead

    expect(resolveOccurredAt(slightlyAhead.toISOString(), NOW)).toEqual(
      slightlyAhead,
    );
  });

  it('rejects an absurdly old timestamp (broken clock, not real backlog)', () => {
    const ancient = new Date(NOW.getTime() - 5 * 24 * 60 * 60_000); // 5 days ago

    expect(resolveOccurredAt(ancient.toISOString(), NOW)).toEqual(NOW);
  });

  it('exposes conservative default bounds', () => {
    expect(DEFAULT_OCCURRED_AT_BOUNDS.maxFutureSkewMs).toBe(2 * 60_000);
    expect(DEFAULT_OCCURRED_AT_BOUNDS.maxPastMs).toBe(2 * 24 * 60 * 60_000);
  });
});
