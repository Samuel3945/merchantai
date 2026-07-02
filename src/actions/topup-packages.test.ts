import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same @/libs/DB mock pattern as topup-confirm.test.ts: a real PGlite-backed
// drizzle instance so the insert...onConflictDoUpdate path (and the
// getGlobalSetting read it shares with global-settings.ts) runs unmodified.

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  operator: null as { userId: string; email: string | null } | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/platform/operator', () => ({
  requirePlatformOperator: vi.fn(async () => {
    if (!h.operator) {
      throw new Error('platform_operator_required');
    }
    return h.operator;
  }),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const DDL = `
  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

const KEY = 'topup_packages';

let pg: PGlite;

async function seedValue(value: string): Promise<void> {
  const { PLATFORM_GLOBAL_ORG_ID } = await import('@/libs/platform/global-settings');
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value) VALUES ($1, $2, $3)`,
    [PLATFORM_GLOBAL_ORG_ID, KEY, value],
  );
}

async function readValue(): Promise<string | undefined> {
  const { PLATFORM_GLOBAL_ORG_ID } = await import('@/libs/platform/global-settings');
  const row = await pg.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE organization_id = $1 AND key = $2`,
    [PLATFORM_GLOBAL_ORG_ID, KEY],
  );
  return row.rows[0]?.value;
}

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM app_settings;');
  h.operator = { userId: 'operator-1', email: 'operator@example.com' };
});

describe('getTopUpPackages', () => {
  it('falls back to defaults when no setting is stored', async () => {
    const { getTopUpPackages } = await import('./topup-packages');
    const { DEFAULT_TOPUP_PACKAGES } = await import('@/libs/topup-catalog');

    expect(await getTopUpPackages()).toEqual(DEFAULT_TOPUP_PACKAGES);
  });

  it('parses a valid stored catalog and derives ids', async () => {
    await seedValue(JSON.stringify([{ requests: 50, amountCop: 10_000 }]));

    const { getTopUpPackages } = await import('./topup-packages');

    expect(await getTopUpPackages()).toEqual([
      { id: 'credits_50', requests: 50, amountCop: 10_000 },
    ]);
  });

  it('falls back to defaults on malformed JSON', async () => {
    await seedValue('{not json');

    const { getTopUpPackages } = await import('./topup-packages');
    const { DEFAULT_TOPUP_PACKAGES } = await import('@/libs/topup-catalog');

    expect(await getTopUpPackages()).toEqual(DEFAULT_TOPUP_PACKAGES);
  });

  it('falls back to defaults on an invalid shape', async () => {
    await seedValue(JSON.stringify([{ requests: -1, amountCop: 10_000 }]));

    const { getTopUpPackages } = await import('./topup-packages');
    const { DEFAULT_TOPUP_PACKAGES } = await import('@/libs/topup-catalog');

    expect(await getTopUpPackages()).toEqual(DEFAULT_TOPUP_PACKAGES);
  });
});

describe('setTopUpPackages', () => {
  it('throws when the caller is not a platform operator', async () => {
    h.operator = null;
    const { setTopUpPackages } = await import('./topup-packages');

    await expect(
      setTopUpPackages([{ requests: 100, amountCop: 1000 }]),
    ).rejects.toThrow('platform_operator_required');
  });

  it('rejects an empty list', async () => {
    const { setTopUpPackages } = await import('./topup-packages');

    const result = await setTopUpPackages([]);

    expect(result.ok).toBe(false);
  });

  it('rejects requests = 0', async () => {
    const { setTopUpPackages } = await import('./topup-packages');

    const result = await setTopUpPackages([{ requests: 0, amountCop: 1000 }]);

    expect(result.ok).toBe(false);
  });

  it('rejects a negative amount', async () => {
    const { setTopUpPackages } = await import('./topup-packages');

    const result = await setTopUpPackages([{ requests: 100, amountCop: -1 }]);

    expect(result.ok).toBe(false);
  });

  it('rejects duplicate requests values', async () => {
    const { setTopUpPackages } = await import('./topup-packages');

    const result = await setTopUpPackages([
      { requests: 100, amountCop: 1000 },
      { requests: 100, amountCop: 2000 },
    ]);

    expect(result.ok).toBe(false);
  });

  it('saves a valid catalog, derives ids, and persists it', async () => {
    const { setTopUpPackages } = await import('./topup-packages');

    const result = await setTopUpPackages([{ requests: 200, amountCop: 30_000 }]);

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'credits_200', requests: 200, amountCop: 30_000 }],
    });
    expect(JSON.parse((await readValue()) ?? '[]')).toEqual([
      { id: 'credits_200', requests: 200, amountCop: 30_000 },
    ]);
  });
});
