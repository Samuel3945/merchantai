/**
 * Unit tests for orderAccountIdsForLock — pure function, no DB required.
 *
 * TDD cycle: written FIRST (RED) before the function exists in treasury.ts.
 *
 * What these tests prove:
 *   - Output is always in ascending lexicographic order (UUIDs sort lexicographically
 *     the same as numerically when lowercase and zero-padded, which is the postgres
 *     default for uuid ORDER BY).
 *   - Duplicate ids are deduplicated before locking (prevents a tx from requesting
 *     the same row lock twice, which would be a no-op but is cleaner to avoid).
 *   - Empty input returns empty output.
 *
 * What these tests do NOT prove:
 *   - The concurrency race is fixed (PGLite is single-connection and cannot model
 *     two truly overlapping transactions — the race fix is argued by code inspection
 *     and the ordered-lock proof in the design document).
 */
import { describe, expect, it } from 'vitest';
import { orderAccountIdsForLock } from '@/libs/treasury';

describe('orderAccountIdsForLock', () => {
  it('returns ids in ascending order', () => {
    const a = '00000000-0000-0000-0000-000000000001';
    const b = '00000000-0000-0000-0000-000000000002';
    const c = '00000000-0000-0000-0000-000000000003';

    expect(orderAccountIdsForLock([c, a, b])).toEqual([a, b, c]);
  });

  it('deduplicates repeated ids', () => {
    const a = '00000000-0000-0000-0000-000000000001';
    const b = '00000000-0000-0000-0000-000000000002';

    expect(orderAccountIdsForLock([a, b, a])).toEqual([a, b]);
  });

  it('returns empty array for empty input', () => {
    expect(orderAccountIdsForLock([])).toEqual([]);
  });

  it('returns single-element array unchanged', () => {
    const a = '00000000-0000-0000-0000-000000000001';

    expect(orderAccountIdsForLock([a])).toEqual([a]);
  });

  it('is stable — same input always produces same output', () => {
    const ids = [
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ];
    const first = orderAccountIdsForLock(ids);
    const second = orderAccountIdsForLock(ids);

    expect(first).toEqual(second);
  });

  it('handles ids that differ only in later segments', () => {
    const a = 'aaaaaaaa-0000-0000-0000-000000000001';
    const b = 'aaaaaaaa-0000-0000-0000-000000000002';

    expect(orderAccountIdsForLock([b, a])).toEqual([a, b]);
  });
});
