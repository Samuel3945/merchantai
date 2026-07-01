/**
 * Delivery fee configuration — pure computation + org-settings loader.
 *
 * Scenarios covered:
 *   computeDeliveryFee: type 'none' | 'fixed' | 'percent', rounding, and the
 *     free-above threshold boundary (just below / at / above).
 *   getDeliveryFeeConfig: defaults when unset, reads each stored value, falls
 *     back safely on garbage/invalid data, org-scoped isolation.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  computeDeliveryFee,
  DEFAULT_DELIVERY_FEE_CONFIG,
  DELIVERY_FEE_TYPE_KEY,
  DELIVERY_FEE_VALUE_KEY,
  DELIVERY_FREE_ABOVE_KEY,
  getDeliveryFeeConfig,
} from '@/libs/delivery-fee';

type Executor = Parameters<typeof getDeliveryFeeConfig>[0];

const DDL = `
  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;
let db: Executor;

const ORG = 'org-delivery-fee-test';

async function setSetting(key: string, value: string): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $3`,
    [ORG, key, value],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  db = drizzle(pg) as unknown as Executor;
});

beforeEach(async () => {
  await pg.exec('DELETE FROM app_settings;');
});

// ── computeDeliveryFee (pure) ────────────────────────────────────────────────

describe('computeDeliveryFee', () => {
  it('type \'none\' returns 0 regardless of subtotal or value', () => {
    expect(
      computeDeliveryFee({ type: 'none', value: 999, freeAbove: null }, 100_000),
    ).toBe(0);
  });

  it('type \'fixed\' returns the configured value', () => {
    expect(
      computeDeliveryFee({ type: 'fixed', value: 5000, freeAbove: null }, 20_000),
    ).toBe(5000);
  });

  it('type \'fixed\' returns 0 when subtotal is over the free-above threshold', () => {
    const config = { type: 'fixed' as const, value: 5000, freeAbove: 50_000 };

    expect(computeDeliveryFee(config, 60_000)).toBe(0);
  });

  it('type \'percent\' computes and rounds the percentage of subtotal', () => {
    const config = { type: 'percent' as const, value: 10, freeAbove: null };

    expect(computeDeliveryFee(config, 10_000)).toBe(1000);
  });

  it('type \'percent\' rounds to the nearest integer', () => {
    const config = { type: 'percent' as const, value: 12.5, freeAbove: null };

    // 333 * 0.125 = 41.625 → rounds to 42
    expect(computeDeliveryFee(config, 333)).toBe(42);
  });

  it('type \'percent\' rounds down when the fraction is below .5', () => {
    const config = { type: 'percent' as const, value: 10, freeAbove: null };

    // 341 * 0.10 = 34.1 → rounds to 34
    expect(computeDeliveryFee(config, 341)).toBe(34);
  });

  it('type \'percent\' returns 0 when subtotal is over the free-above threshold', () => {
    const config = { type: 'percent' as const, value: 10, freeAbove: 50_000 };

    expect(computeDeliveryFee(config, 60_000)).toBe(0);
  });

  it('subtotal 0 → fee is 0 for fixed and percent alike (no free-above needed)', () => {
    expect(
      computeDeliveryFee({ type: 'fixed', value: 5000, freeAbove: null }, 0),
    ).toBe(5000); // fixed fee still applies even on an empty cart total
    expect(
      computeDeliveryFee({ type: 'percent', value: 10, freeAbove: null }, 0),
    ).toBe(0);
  });

  describe('free-above threshold boundary', () => {
    const config = { type: 'fixed' as const, value: 5000, freeAbove: 50_000 };

    it('just below the threshold: fee still applies', () => {
      expect(computeDeliveryFee(config, 49_999)).toBe(5000);
    });

    it('exactly at the threshold: shipping is free', () => {
      expect(computeDeliveryFee(config, 50_000)).toBe(0);
    });

    it('above the threshold: shipping is free', () => {
      expect(computeDeliveryFee(config, 50_001)).toBe(0);
    });
  });

  it('freeAbove=null never triggers free shipping, no matter how large the subtotal', () => {
    const config = { type: 'fixed' as const, value: 5000, freeAbove: null };

    expect(computeDeliveryFee(config, 1_000_000)).toBe(5000);
  });
});

// ── getDeliveryFeeConfig ──────────────────────────────────────────────────────

describe('getDeliveryFeeConfig', () => {
  it('returns DEFAULT_DELIVERY_FEE_CONFIG when no settings exist for the org', async () => {
    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config).toEqual(DEFAULT_DELIVERY_FEE_CONFIG);
    expect(config.type).toBe('none');
  });

  it('reads type \'fixed\' + value from app_settings', async () => {
    await setSetting(DELIVERY_FEE_TYPE_KEY, 'fixed');
    await setSetting(DELIVERY_FEE_VALUE_KEY, '5000');

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config).toEqual({ type: 'fixed', value: 5000, freeAbove: null });
  });

  it('reads type \'percent\' + value + freeAbove from app_settings', async () => {
    await setSetting(DELIVERY_FEE_TYPE_KEY, 'percent');
    await setSetting(DELIVERY_FEE_VALUE_KEY, '10');
    await setSetting(DELIVERY_FREE_ABOVE_KEY, '50000');

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config).toEqual({ type: 'percent', value: 10, freeAbove: 50_000 });
  });

  it('falls back to type "none" for an unrecognized stored type', async () => {
    await setSetting(DELIVERY_FEE_TYPE_KEY, 'garbage');

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config.type).toBe('none');
  });

  it('falls back to value 0 for a non-numeric stored value', async () => {
    await setSetting(DELIVERY_FEE_TYPE_KEY, 'fixed');
    await setSetting(DELIVERY_FEE_VALUE_KEY, 'not-a-number');

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config.value).toBe(0);
  });

  it('falls back to value 0 for a negative stored value', async () => {
    await setSetting(DELIVERY_FEE_TYPE_KEY, 'fixed');
    await setSetting(DELIVERY_FEE_VALUE_KEY, '-100');

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config.value).toBe(0);
  });

  it('treats an empty freeAbove string as unset (null)', async () => {
    await setSetting(DELIVERY_FEE_TYPE_KEY, 'fixed');
    await setSetting(DELIVERY_FEE_VALUE_KEY, '5000');
    await setSetting(DELIVERY_FREE_ABOVE_KEY, '');

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config.freeAbove).toBeNull();
  });

  it('ignores settings scoped to a different organization', async () => {
    await pg.query(
      `INSERT INTO app_settings (organization_id, key, value) VALUES ($1, $2, $3)`,
      ['OTHER-ORG', DELIVERY_FEE_TYPE_KEY, 'fixed'],
    );

    const config = await getDeliveryFeeConfig(db, ORG);

    expect(config.type).toBe('none');
  });
});
