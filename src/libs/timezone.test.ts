import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORG_TIMEZONE,
  isSupportedTimezone,
  resolveOrgTimezone,
  SUPPORTED_TIMEZONES,
} from '@/libs/timezone';

// The org timezone is timezone-dynamic in code but Colombia-only by policy for
// now. These pin both halves: the resolver never yields an unsupported zone,
// and the supported set is the single place /platform widens later.

describe('resolveOrgTimezone', () => {
  it('keeps a supported stored zone', () => {
    expect(resolveOrgTimezone('America/Bogota')).toBe('America/Bogota');
  });

  it('falls back to the default when unset', () => {
    expect(resolveOrgTimezone(null)).toBe(DEFAULT_ORG_TIMEZONE);
    expect(resolveOrgTimezone(undefined)).toBe(DEFAULT_ORG_TIMEZONE);
    expect(resolveOrgTimezone('')).toBe(DEFAULT_ORG_TIMEZONE);
  });

  it('falls back when the stored zone is not yet supported', () => {
    // A zone we will allow LATER (via /platform) must not leak through today.
    expect(resolveOrgTimezone('America/Mexico_City')).toBe(DEFAULT_ORG_TIMEZONE);
    expect(resolveOrgTimezone('garbage')).toBe(DEFAULT_ORG_TIMEZONE);
  });
});

describe('isSupportedTimezone', () => {
  it('accepts only the current allow-list', () => {
    expect(isSupportedTimezone('America/Bogota')).toBe(true);
    expect(isSupportedTimezone('America/Mexico_City')).toBe(false);
    expect(isSupportedTimezone(null)).toBe(false);
  });
});

describe('SUPPORTED_TIMEZONES', () => {
  it('is Colombia-only for now', () => {
    expect(SUPPORTED_TIMEZONES).toEqual(['America/Bogota']);
  });
});
