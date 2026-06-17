/**
 * PR4 — Axis-1 arrival paths (action layer, Strict TDD)
 *
 * RED tests written BEFORE the implementation.
 *
 * Scenarios covered:
 *   S-02: Late full arrival via confirmLateTransfer — treasury credit posted
 *   S-03: Partial arrival via partialTransferArrival — credit for X, remainder row created
 *   S-03b: Invalid partial amounts rejected at the action layer
 *
 * The treasury deposit (depositConfirmedTransfer) is mocked to avoid needing
 * treasury_movements / treasury_accounts DDL in PGLite. We assert the mock
 * is called with the correct amount.
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
  orgId: 'org-arrivals-action',
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

// Mock treasury so we avoid needing treasury_accounts DDL.
// We capture calls to verify the correct amount is deposited.
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
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_at timestamp DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    closed_at timestamp,
    closed_by text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text
  );

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
    resolution_fiado_id uuid,
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
`;

const ORG = 'org-arrivals-action';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;
let pg: PGlite;

async function seedNotArrived(expectedAmount = '100.00'): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES ($1, $2, 'Transferencia', $3, 'not_arrived')`,
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

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM transfer_reconciliations');
  counter = 0;
  h.depositCalls = [];
  h.orgRole = 'org:admin';
  vi.clearAllMocks();
  // Re-set the deposit mock (vi.clearAllMocks clears implementation)
  const { depositConfirmedTransfer } = await import('@/libs/treasury');
  (depositConfirmedTransfer as ReturnType<typeof vi.fn>).mockImplementation(
    async (_executor: unknown, args: { reconciliationId: string; amount: number | string }) => {
      h.depositCalls.push({ reconciliationId: args.reconciliationId, amount: args.amount });
      return { deposited: true };
    },
  );
});

// ── S-02: Late full arrival (action layer) ────────────────────────────────────

describe('S-02: confirmLateTransfer — late full arrival', () => {
  it('moves status to confirmed', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const id = await seedNotArrived();

    const result = await confirmLateTransfer(id);

    expect(result.ok).toBe(true);

    const row = await pg.query<{ status: string }>(
      `SELECT status FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.status).toBe('confirmed');
  });

  it('calls depositConfirmedTransfer with the full expected amount', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('150.00');

    await confirmLateTransfer(id);

    expect(h.depositCalls).toHaveLength(1);

    // Amount can be string or number — normalize to number for comparison
    const depositedAmount = Number(h.depositCalls[0]?.amount);

    expect(depositedAmount).toBeCloseTo(150, 2);
  });

  it('returns the updated reconciliation row', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('200.00');

    const result = await confirmLateTransfer(id);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.data.id).toBe(id);
    expect(result.data.status).toBe('confirmed');
  });

  it('returns an error when the row does not exist', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const unknownId = UUID(9999);

    const result = await confirmLateTransfer(unknownId);

    expect(result.ok).toBe(false);
  });
});

// ── S-03: Partial arrival (action layer) ─────────────────────────────────────

describe('S-03: partialTransferArrival — partial arrival', () => {
  it('sets original row to resolved with correct arrived_amount', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 60);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.data.original.status).toBe('resolved');
    expect(Number(result.data.original.arrivedAmount)).toBeCloseTo(60, 2);
  });

  it('creates a remainder row with expected = original - arrived', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 60);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.data.remainder.status).toBe('not_arrived');
    expect(Number(result.data.remainder.expectedAmount)).toBeCloseTo(40, 2);
  });

  it('links original.remainder_reconciliation_id to remainder.id', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 60);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.data.original.remainderReconciliationId).toBe(result.data.remainder.id);
  });

  it('posts treasury credit for arrived amount only', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    await partialTransferArrival(id, 60);

    expect(h.depositCalls).toHaveLength(1);

    const depositedAmount = Number(h.depositCalls[0]?.amount);

    expect(depositedAmount).toBeCloseTo(60, 2);
  });

  it('CONSERVATION LAW: arrived + remainder.expected === original expected', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 60);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const arrived = Number(result.data.original.arrivedAmount);
    const remainder = Number(result.data.remainder.expectedAmount);

    expect(arrived + remainder).toBeCloseTo(100, 2);
  });

  it('returns an error when the row does not exist', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const unknownId = UUID(9999);

    const result = await partialTransferArrival(unknownId, 60);

    expect(result.ok).toBe(false);
  });
});

// ── S-03b: Invalid partial amounts (action layer) ─────────────────────────────

describe('S-03b: partialTransferArrival — invalid amounts', () => {
  it('rejects arrived_amount === 0', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 0);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error).toMatch(/monto|amount|mayor/i);
  });

  it('rejects arrived_amount === expected_amount (use confirmLateTransfer instead)', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 100);

    expect(result.ok).toBe(false);
  });

  it('rejects arrived_amount > expected_amount', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, 150);

    expect(result.ok).toBe(false);
  });

  it('rejects negative arrived_amount', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedNotArrived('100.00');

    const result = await partialTransferArrival(id, -10);

    expect(result.ok).toBe(false);
  });
});

// ── FIX 2: current-status guard on arrival actions ────────────────────────────
// Arrival actions may only act on an investigable row (not_arrived / mismatch).
// A replayed call on a terminal `resolved` row, or a duplicate confirm on an
// already-`confirmed` row, must be rejected — never silently re-mutate.

describe('FIX 2: confirmLateTransfer rejects non-investigable statuses', () => {
  it('rejects a resolved (terminal) row', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const id = await seedWithStatus('resolved');

    const result = await confirmLateTransfer(id);

    expect(result.ok).toBe(false);
  });

  it('rejects an already-confirmed row (replay)', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const id = await seedWithStatus('confirmed');

    const result = await confirmLateTransfer(id);

    expect(result.ok).toBe(false);
  });

  it('still allows a mismatch row', async () => {
    const { confirmLateTransfer } = await import('./transfer-reconciliation');
    const id = await seedWithStatus('mismatch');

    const result = await confirmLateTransfer(id);

    expect(result.ok).toBe(true);
  });
});

describe('FIX 2: partialTransferArrival rejects non-investigable statuses', () => {
  it('rejects a resolved (terminal) row', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedWithStatus('resolved');

    const result = await partialTransferArrival(id, 60);

    expect(result.ok).toBe(false);
  });

  it('rejects an already-confirmed row', async () => {
    const { partialTransferArrival } = await import('./transfer-reconciliation');
    const id = await seedWithStatus('confirmed');

    const result = await partialTransferArrival(id, 60);

    expect(result.ok).toBe(false);
  });
});
