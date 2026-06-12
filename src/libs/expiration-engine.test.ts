import { describe, expect, it } from 'vitest';
import { classifyTier } from './expiration-engine';

describe('classifyTier', () => {
  it('never flags batches beyond the risk horizon', () => {
    // The original bug: a product expiring in 15 months showed "Por vencer".
    expect(classifyTier(null, 470)).toBeNull();
    expect(classifyTier(0.06, 470)).toBeNull();
    expect(classifyTier(5, 200)).toBeNull();
  });

  it('uses date proximity when there is no sales velocity', () => {
    expect(classifyTier(null, 5)).toBe('critico');
    expect(classifyTier(null, 10)).toBe('urgente');
    expect(classifyTier(null, 25)).toBe('atencion');
    expect(classifyTier(null, 60)).toBeNull();
  });

  it('treats a low risk ratio as no risk', () => {
    // Sells out in 10 days, expires in 100 — nothing to worry about.
    expect(classifyTier(0.1, 100)).toBeNull();
    expect(classifyTier(0.49, 100)).toBeNull();
  });

  it('escalates as sell-out time approaches expiry', () => {
    expect(classifyTier(0.5, 100)).toBe('atencion');
    expect(classifyTier(0.75, 100)).toBe('urgente');
    expect(classifyTier(1, 100)).toBe('critico');
    expect(classifyTier(3, 100)).toBe('critico');
  });

  it('always flags the final week even when selling fast', () => {
    expect(classifyTier(0.1, 7)).toBe('atencion');
    expect(classifyTier(0.1, 8)).toBeNull();
  });
});
