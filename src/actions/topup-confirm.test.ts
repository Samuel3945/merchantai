import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Idempotency guarantee for applyApprovedTopUp (actions/plans.ts): the atomic
// claim (`status: 'pending' -> 'approved'`, gated by a WHERE on the current
// status) + usage_counters pool increment that runs once Wompi confirms an
// APPROVED transaction. Two calls for the same reference — e.g. the webhook
// retrying, or the webhook racing the authoritative-query fallback — must
// grant credits exactly ONCE. Exercised against real Postgres (PGlite),
// mirroring the existing @/libs/DB mock pattern (see
// transfer-reconciliation-novelty.test.ts) so the real exported function runs
// unmodified.

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

const DDL = `
  CREATE TABLE top_ups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    agent_kind text,
    amount_cop numeric(12, 2) DEFAULT '0' NOT NULL,
    requests_added integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    reference text,
    wompi_transaction_id text,
    created_at timestamp DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX top_ups_reference_unique_idx ON top_ups (reference);

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

const ORG = 'org-topup-test';
const REFERENCE = 'topup-test-ref-1';

let pg: PGlite;

async function seedTopUp(status = 'pending', requests = 100): Promise<void> {
  await pg.query(
    `INSERT INTO top_ups (organization_id, amount_cop, requests_added, status, reference)
     VALUES ($1, '19000', $2, $3, $4)`,
    [ORG, requests, status, REFERENCE],
  );
}

async function seedCounter(toppedUp = 0): Promise<void> {
  await pg.query(
    `INSERT INTO usage_counters (organization_id, agent_kind, used, monthly_limit, topped_up)
     VALUES ($1, 'pool', 0, 100, $2)`,
    [ORG, toppedUp],
  );
}

async function toppedUpOf(): Promise<number> {
  const row = await pg.query<{ topped_up: number }>(
    `SELECT topped_up FROM usage_counters WHERE organization_id = $1`,
    [ORG],
  );
  return Number(row.rows[0]?.topped_up ?? 0);
}

async function statusAndTxIdOf(): Promise<{ status?: string; wompiTransactionId?: string | null }> {
  const row = await pg.query<{ status: string; wompi_transaction_id: string | null }>(
    `SELECT status, wompi_transaction_id FROM top_ups WHERE reference = $1`,
    [REFERENCE],
  );
  return {
    status: row.rows[0]?.status,
    wompiTransactionId: row.rows[0]?.wompi_transaction_id,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM top_ups; DELETE FROM usage_counters;');
});

describe('applyApprovedTopUp', () => {
  it('grants the credits and flips status to approved', async () => {
    await seedTopUp('pending', 100);
    await seedCounter(0);

    const { applyApprovedTopUp } = await import('./plans');
    await applyApprovedTopUp(REFERENCE, 'wompi-tx-1');

    const { status, wompiTransactionId } = await statusAndTxIdOf();

    expect(status).toBe('approved');
    expect(wompiTransactionId).toBe('wompi-tx-1');
    expect(await toppedUpOf()).toBe(100);
  });

  it('is idempotent: a second call for the same reference grants nothing more', async () => {
    await seedTopUp('pending', 100);
    await seedCounter(0);

    const { applyApprovedTopUp } = await import('./plans');
    await applyApprovedTopUp(REFERENCE, 'wompi-tx-1');
    await applyApprovedTopUp(REFERENCE, 'wompi-tx-1');

    expect(await toppedUpOf()).toBe(100);
    expect((await statusAndTxIdOf()).status).toBe('approved');
  });

  it('grants nothing for a reference that is not pending (already declined)', async () => {
    await seedTopUp('declined', 100);
    await seedCounter(0);

    const { applyApprovedTopUp } = await import('./plans');
    await applyApprovedTopUp(REFERENCE, 'wompi-tx-1');

    expect(await toppedUpOf()).toBe(0);
    expect((await statusAndTxIdOf()).status).toBe('declined');
  });

  it('is a no-op for an unknown reference', async () => {
    await seedCounter(0);

    const { applyApprovedTopUp } = await import('./plans');

    await expect(
      applyApprovedTopUp('bogus-reference', null),
    ).resolves.toBeUndefined();

    expect(await toppedUpOf()).toBe(0);
  });
});
