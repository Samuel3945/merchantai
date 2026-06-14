import type { OrgEntitlements } from '@/libs/entitlements';
import { describe, expect, it } from 'vitest';
import { hasFeature, limitOf } from '@/libs/entitlements';

// Pure-function gates that decide what a paying org may do. A regression here
// silently grants or denies access, so the semantics are pinned down here —
// especially the `?? fallback` nuance (0 is a real stored value, not "missing").

const ent: OrgEntitlements = {
  planSlug: 'pro',
  planName: 'Pro',
  limits: {
    max_pos_devices: 3,
    feature_smart_stock: 1,
    ai_credits_sales_manager: 0,
  },
};

describe('limitOf', () => {
  it('returns the stored limit when the key is present', () => {
    expect(limitOf(ent, 'max_pos_devices')).toBe(3);
  });

  it('returns the default fallback (0) for a missing key', () => {
    expect(limitOf(ent, 'max_cashiers')).toBe(0);
  });

  it('returns an explicit fallback for a missing key', () => {
    expect(limitOf(ent, 'max_cashiers', 1)).toBe(1);
  });

  it('keeps a stored 0 and never applies the fallback over it', () => {
    // `?? ` only falls back on null/undefined, not on a legitimate 0. A plan that
    // explicitly grants 0 credits must read as 0, not as the fallback.
    expect(limitOf(ent, 'ai_credits_sales_manager', 99)).toBe(0);
  });
});

describe('hasFeature', () => {
  it('grants a feature whose value is >= 1', () => {
    expect(hasFeature(ent, 'feature_smart_stock')).toBe(true);
  });

  it('denies a feature whose value is 0', () => {
    expect(hasFeature(ent, 'ai_credits_sales_manager')).toBe(false);
  });

  it('denies a feature that is absent from the plan', () => {
    expect(hasFeature(ent, 'feature_unknown')).toBe(false);
  });
});
