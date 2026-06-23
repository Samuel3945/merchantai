import { describe, expect, it } from 'vitest';
import { isUuid, normalizeIdempotencyKey } from './uuid';

describe('isUuid', () => {
  it('accepts a well-formed UUID (any version, any case)', () => {
    expect(isUuid('cccccccc-cccc-cccc-cccc-cccccccccccc')).toBe(true);
    expect(isUuid('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
  });

  it('accepts the nil UUID as syntactically valid', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('normalizeIdempotencyKey', () => {
  it('returns the trimmed key for a valid UUID', () => {
    expect(normalizeIdempotencyKey('  cccccccc-cccc-cccc-cccc-cccccccccccc  '))
      .toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('returns null for null/empty/whitespace (no dedupe, normal create)', () => {
    expect(normalizeIdempotencyKey(null)).toBeNull();
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey('')).toBeNull();
    expect(normalizeIdempotencyKey('   ')).toBeNull();
  });

  it('returns null for a non-UUID string (back-compat, never throws 22P02)', () => {
    expect(normalizeIdempotencyKey('garbage')).toBeNull();
  });

  it('rejects the nil UUID so it never dedupes unrelated sales', () => {
    // The nil UUID is syntactically valid but is a placeholder, not a real
    // device-generated key. Treating it as one would collapse every "no key"
    // sale from a buggy client into a single sale.
    expect(normalizeIdempotencyKey('00000000-0000-0000-0000-000000000000'))
      .toBeNull();
  });
});
