import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test for the shared-pool consumeCreditForOrg guarantee
// (actions/plans.ts): the AI credit decrement increments `used` only WHERE
// `used < monthly_limit + topped_up` on the SINGLE pool row per org, in one
// atomic statement — so repeated/concurrent consumption can never push usage
// past the org's purchased credits, and never go negative. Exercised against
// a real Postgres engine (PGlite) so the real exported function runs
// unmodified, mirroring the @/libs/DB mock pattern used across this repo.

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: null, orgId: null, orgRole: null })),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Minimal shape of `plans` / `subscriptions` — empty in these tests, but
// ensureCountersForPlan() (called internally by consumeCreditForOrg) always
// resolves the org's active plan and its pool limit before touching
// usage_counters, so the tables must exist even when unused.
const DDL = `
  CREATE TABLE plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL
  );

  CREATE TABLE subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    plan text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    period_start timestamp DEFAULT now() NOT NULL,
    period_end timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE usage_counters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    agent_kind text NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    monthly_limit integer DEFAULT 0 NOT NULL,
    topped_up integer DEFAULT 0 NOT NULL,
    reset_at timestamp
  );
  CREATE UNIQUE INDEX usage_counters_org_unique_idx ON usage_counters (organization_id);
`;

const ORG = 'org-test';

let pg: PGlite;

async function seedPool(monthlyLimit: number, toppedUp: number, used = 0): Promise<void> {
  await pg.query(
    `INSERT INTO usage_counters (organization_id, agent_kind, used, monthly_limit, topped_up)
     VALUES ($1, 'pool', $2, $3, $4)`,
    [ORG, used, monthlyLimit, toppedUp],
  );
}

async function usedOf(orgId = ORG): Promise<number> {
  const row = await pg.query<{ used: number }>(
    `SELECT used FROM usage_counters WHERE organization_id = $1`,
    [orgId],
  );
  return Number(row.rows[0]?.used ?? 0);
}

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM usage_counters; DELETE FROM subscriptions; DELETE FROM plans;');
});

describe('consumeCreditForOrg pool guarantee', () => {
  it('allows exactly monthly_limit + topped_up consumptions, then refuses', async () => {
    await seedPool(2, 1);

    const { consumeCreditForOrg } = await import('./plans');
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push((await consumeCreditForOrg(ORG)).success);
    }

    // 3 credits available (2 monthly + 1 topped up); the 4th and 5th are refused.
    expect(results).toEqual([true, true, true, false, false]);
    expect(await usedOf()).toBe(3);
  });

  it('refuses immediately when already at the limit (never goes over)', async () => {
    await seedPool(5, 0, 5);

    const { consumeCreditForOrg } = await import('./plans');
    const result = await consumeCreditForOrg(ORG);

    expect(result.success).toBe(false);
    expect(await usedOf()).toBe(5);
  });

  it('never consumes another org\'s credits', async () => {
    await pg.query(
      `INSERT INTO usage_counters (organization_id, agent_kind, used, monthly_limit, topped_up)
       VALUES ('other-org', 'pool', 0, 10, 0)`,
    );

    // ORG has no pool row and no plan configured, so its freshly-created pool
    // caps at 0 and the credit is refused — critically, 'other-org' is untouched.
    const { consumeCreditForOrg } = await import('./plans');
    const result = await consumeCreditForOrg(ORG);

    expect(result.success).toBe(false);
    expect(await usedOf('other-org')).toBe(0);
  });
});
