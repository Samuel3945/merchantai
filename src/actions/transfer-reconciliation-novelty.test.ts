/**
 * recordTransferNovelty — the verification-time "Novedad" entry (action layer).
 *
 * One entry collapses the cashier's options at verification time into Confirmar
 * (exact match, separate action) + Novedad (enter what really arrived). This
 * suite pins the server-side more/less/zero routing:
 *
 *   • arrived >= expected → confirm at the real amount (surplus deposits the
 *     real figure; nothing to investigate).
 *   • 0 < arrived < expected → partial: confirm + deposit the arrived portion;
 *     remainder routed by the org's default-resolution setting.
 *   • arrived === 0 → nothing landed; routed by default-resolution.
 *
 * Treasury (depositConfirmedTransfer) is mocked, as in the arrivals suite, so we
 * don't need treasury DDL in PGLite — we assert the captured deposit amount.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Hoisted mutable state ─────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgRole: 'org:admin' as string,
  orgId: 'org-novelty-action',
  userId: 'user_test',
  depositCalls: [] as Array<{ reconciliationId: string; amount: number | string }>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
    orgRole: h.orgRole,
  })),
  currentUser: vi.fn(async () => ({ fullName: 'Test User' })),
}));

vi.mock('@/libs/panel-session', () => ({
  requirePanelModule: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
  })),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@/libs/treasury', () => ({
  depositConfirmedTransfer: vi.fn(async (
    _executor: unknown,
    args: { reconciliationId: string; amount: number | string },
  ) => {
    h.depositCalls.push({ reconciliationId: args.reconciliationId, amount: args.amount });
    return { deposited: true };
  }),
  adjustConfirmedTransferDeposit: vi.fn(async () => ({ delta: 0 })),
}));

// ── PGLite schema ─────────────────────────────────────────────────────────────

const SETUP_SQL = `
  CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved');
  CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability');

  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid,
    pos_token_id uuid,
    cash_session_id uuid,
    method text NOT NULL,
    expected_amount numeric(12, 2) NOT NULL,
    arrived_amount numeric(12, 2),
    reference text,
    status "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
    reconciled_by text,
    reconciled_at timestamp,
    note text,
    resolution_type "transfer_resolution_type",
    resolved_by text,
    resolved_at timestamp,
    resolution_credito_id uuid,
    claim_open boolean DEFAULT false NOT NULL,
    recovery_of_id uuid,
    remainder_reconciliation_id uuid,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX transfer_reconciliations_sale_payment_idx
    ON transfer_reconciliations (sale_payment_id)
    WHERE sale_payment_id IS NOT NULL;

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

const ORG = 'org-novelty-action';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;
let pg: PGlite;

async function seedPending(expectedAmount = '100.00'): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES ($1, $2, 'Transferencia', $3, 'pending')`,
    [id, ORG, expectedAmount],
  );
  return id;
}

async function seedWithStatus(
  status: string,
  expectedAmount = '100.00',
): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES ($1, $2, 'Transferencia', $3, $4)`,
    [id, ORG, expectedAmount, status],
  );
  return id;
}

async function setSetting(key: string, value: string): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [ORG, key, value],
  );
}

async function statusOf(id: string): Promise<string | undefined> {
  const row = await pg.query<{ status: string }>(
    `SELECT status FROM transfer_reconciliations WHERE id = $1`,
    [id],
  );
  return row.rows[0]?.status;
}

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM transfer_reconciliations; DELETE FROM app_settings;');
  counter = 0;
  h.depositCalls = [];
  h.orgRole = 'org:admin';
  vi.clearAllMocks();
  const { depositConfirmedTransfer } = await import('@/libs/treasury');
  (depositConfirmedTransfer as ReturnType<typeof vi.fn>).mockImplementation(
    async (_executor: unknown, args: { reconciliationId: string; amount: number | string }) => {
      h.depositCalls.push({ reconciliationId: args.reconciliationId, amount: args.amount });
      return { deposited: true };
    },
  );
});

// ── Exact / surplus → confirm at the real amount ─────────────────────────────

describe('recordTransferNovelty — exact amount', () => {
  it('confirms the row when arrived === expected', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 100);

    expect(result.ok).toBe(true);
    expect(await statusOf(id)).toBe('confirmed');
  });
});

describe('recordTransferNovelty — surplus (arrived > expected)', () => {
  it('confirms the row ("no pasa nada")', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 120);

    expect(result.ok).toBe(true);
    expect(await statusOf(id)).toBe('confirmed');
  });

  it('deposits the REAL (higher) amount, not the expected', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    await recordTransferNovelty(id, 120);

    expect(h.depositCalls).toHaveLength(1);
    expect(Number(h.depositCalls[0]?.amount)).toBeCloseTo(120, 2);
  });
});

// ── Shortfall (0 < arrived < expected) → partial + setting routing ───────────

describe('recordTransferNovelty — shortfall (partial)', () => {
  it('default (investigate): confirms arrived portion, parks remainder as not_arrived', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 60);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    // The returned row is the resolved original carrying the arrived amount.
    expect(result.data.status).toBe('resolved');
    expect(Number(result.data.arrivedAmount)).toBeCloseTo(60, 2);

    // A separate remainder row sits in not_arrived for investigation.
    const remainder = await pg.query<{ status: string; expected_amount: string }>(
      `SELECT status, expected_amount FROM transfer_reconciliations WHERE id <> $1`,
      [id],
    );

    expect(remainder.rows[0]?.status).toBe('not_arrived');
    expect(Number(remainder.rows[0]?.expected_amount)).toBeCloseTo(40, 2);
  });

  it('deposits only the arrived portion', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    await recordTransferNovelty(id, 60);

    expect(h.depositCalls).toHaveLength(1);
    expect(Number(h.depositCalls[0]?.amount)).toBeCloseTo(60, 2);
  });

  it('direct_loss: confirms arrived portion, closes remainder as a loss', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    await setSetting('transfer-default-resolution', 'direct_loss');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 60);

    expect(result.ok).toBe(true);

    const remainder = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id <> $1`,
      [id],
    );

    expect(remainder.rows[0]?.status).toBe('resolved');
    expect(remainder.rows[0]?.resolution_type).toBe('loss');
  });
});

// ── Nothing landed (arrived === 0) → the former "No llegó" ───────────────────

describe('recordTransferNovelty — nothing arrived (0)', () => {
  it('default (investigate): parks the row as not_arrived, no deposit', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 0);

    expect(result.ok).toBe(true);
    expect(await statusOf(id)).toBe('not_arrived');
    expect(h.depositCalls).toHaveLength(0);
  });

  it('direct_loss: closes the row as a loss, no deposit', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    await setSetting('transfer-default-resolution', 'direct_loss');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 0);

    expect(result.ok).toBe(true);
    expect(await statusOf(id)).toBe('resolved');
    expect(h.depositCalls).toHaveLength(0);

    const row = await pg.query<{ resolution_type: string }>(
      `SELECT resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.resolution_type).toBe('loss');
  });
});

// ── Guards ───────────────────────────────────────────────────────────────────

describe('recordTransferNovelty — guards', () => {
  it('rejects a non-pending row (already confirmed)', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedWithStatus('confirmed');

    const result = await recordTransferNovelty(id, 60);

    expect(result.ok).toBe(false);
  });

  it('rejects an unknown row', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');

    const result = await recordTransferNovelty(UUID(9999), 60);

    expect(result.ok).toBe(false);
  });

  it('rejects a negative amount', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, -10);

    expect(result.ok).toBe(false);
    expect(await statusOf(id)).toBe('pending');
  });

  it('rejects a non-numeric amount', async () => {
    const { recordTransferNovelty } = await import('./transfer-reconciliation');
    const id = await seedPending('100.00');

    const result = await recordTransferNovelty(id, 'abc');

    expect(result.ok).toBe(false);
    expect(await statusOf(id)).toBe('pending');
  });
});
