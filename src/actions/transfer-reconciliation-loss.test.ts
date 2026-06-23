/**
 * PR5 — Loss + reclamo + cross-period recovery (action layer, Strict TDD)
 *
 * RED tests written BEFORE the implementation.
 *
 * Scenarios covered:
 *   S-06: resolveTransfer(loss) — no new treasury movement via action layer
 *   S-07: resolveTransfer(loss, claimOpen) — claim_open=true via action layer
 *   S-08: resolveTransfer(cashier_liability) — no new treasury movement
 *   S-09: recoverTransfer — new confirmed row + treasury deposit called
 *   S-10: recoverTransfer after claim — old row immutable
 *   S-22: recoverTransfer on non-loss row — rejected in action layer
 *
 * treasury is mocked to capture calls and assert the correct invariants.
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
  orgId: 'org-loss-action',
  userId: 'user_admin',
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
  currentUser: vi.fn(async () => ({ fullName: 'Admin User' })),
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

// Mock treasury so we avoid needing the full treasury DDL.
// We capture deposit calls to verify correct amounts and assert no calls for loss.
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
    opening_explanation text,
    client_session_id uuid
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

const ORG = 'org-loss-action';
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

async function seedLossRow(overrides: { claimOpen?: boolean; expectedAmount?: string } = {}): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status, resolution_type, claim_open, resolved_by, resolved_at)
     VALUES ($1, $2, 'Transferencia', $3, 'resolved', 'loss', $4, 'Admin', now())`,
    [id, ORG, overrides.expectedAmount ?? '100.00', overrides.claimOpen ?? false],
  );
  return id;
}

async function seedResolvedCashierLiability(): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status, resolution_type, resolved_by, resolved_at)
     VALUES ($1, $2, 'Transferencia', '200.00', 'resolved', 'cashier_liability', 'Admin', now())`,
    [id, ORG],
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

  // Re-set deposit mock after clearAllMocks (implementation is cleared)
  const { depositConfirmedTransfer } = await import('@/libs/treasury');
  (depositConfirmedTransfer as ReturnType<typeof vi.fn>).mockImplementation(
    async (_executor: unknown, args: { reconciliationId: string; amount: number | string }) => {
      h.depositCalls.push({ reconciliationId: args.reconciliationId, amount: args.amount });
      return { deposited: true };
    },
  );
});

// ── S-06: resolveTransfer(loss) — no treasury deposit call ───────────────────

describe('S-06: resolveTransfer(loss) — no cash movement via action', () => {
  it('marks the row as resolved with resolution_type loss', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived();

    const result = await resolveTransfer(id, 'loss');

    expect(result.ok).toBe(true);

    const row = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.status).toBe('resolved');
    expect(row.rows[0]?.resolution_type).toBe('loss');
  });

  it('does NOT call depositConfirmedTransfer (no treasury movement)', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived();

    await resolveTransfer(id, 'loss');

    expect(h.depositCalls).toHaveLength(0);
  });

  it('claim_open stays false when no claimInput is passed', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived();

    await resolveTransfer(id, 'loss');

    const row = await pg.query<{ claim_open: boolean }>(
      `SELECT claim_open FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.claim_open).toBe(false);
  });
});

// ── S-07: resolveTransfer(loss, claimOpen) ───────────────────────────────────

describe('S-07: resolveTransfer with claimOpen=true — PÉRDIDA+RECLAMO', () => {
  it('marks the row as resolved/loss with claim_open=true', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived('80.00');

    const result = await resolveTransfer(id, 'loss', undefined, true);

    expect(result.ok).toBe(true);

    const row = await pg.query<{ status: string; resolution_type: string; claim_open: boolean }>(
      `SELECT status, resolution_type, claim_open FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.status).toBe('resolved');
    expect(row.rows[0]?.resolution_type).toBe('loss');
    expect(row.rows[0]?.claim_open).toBe(true);
  });

  it('does NOT call depositConfirmedTransfer for loss+claim (no treasury movement)', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived('80.00');

    await resolveTransfer(id, 'loss', undefined, true);

    expect(h.depositCalls).toHaveLength(0);
  });
});

// ── S-08: resolveTransfer(cashier_liability) — no treasury deposit call ───────

describe('S-08: resolveTransfer(cashier_liability) — no treasury movement', () => {
  it('marks the row as resolved with resolution_type cashier_liability', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived('200.00');

    const result = await resolveTransfer(id, 'cashier_liability');

    expect(result.ok).toBe(true);

    const row = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.status).toBe('resolved');
    expect(row.rows[0]?.resolution_type).toBe('cashier_liability');
  });

  it('does NOT call depositConfirmedTransfer', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived('200.00');

    await resolveTransfer(id, 'cashier_liability');

    expect(h.depositCalls).toHaveLength(0);
  });
});

// ── S-09: recoverTransfer — new confirmed row + treasury deposit ───────────────

describe('S-09: recoverTransfer — creates recovery row and posts treasury credit', () => {
  it('creates a new confirmed row with recovery_of_id referencing the old loss', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const oldLossId = await seedLossRow();

    const result = await recoverTransfer(oldLossId, 100);

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ status: string; recovery_of_id: string }>(
      `SELECT status, recovery_of_id FROM transfer_reconciliations WHERE recovery_of_id = $1`,
      [oldLossId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('confirmed');
    expect(rows.rows[0]?.recovery_of_id).toBe(oldLossId);
  });

  it('does NOT modify the original loss row (immutability)', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const oldLossId = await seedLossRow();

    const [before] = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [oldLossId],
    ).then(r => r.rows);

    await recoverTransfer(oldLossId, 100);

    const [after] = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [oldLossId],
    ).then(r => r.rows);

    expect(after?.status).toBe(before?.status);
    expect(after?.resolution_type).toBe(before?.resolution_type);
  });

  it('calls depositConfirmedTransfer exactly once for the recovery amount', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const oldLossId = await seedLossRow({ expectedAmount: '100.00' });

    await recoverTransfer(oldLossId, 75);

    expect(h.depositCalls).toHaveLength(1);

    const depositedAmount = Number(h.depositCalls[0]?.amount);

    expect(depositedAmount).toBeCloseTo(75, 2);
  });
});

// ── S-10: recoverTransfer after PÉRDIDA+RECLAMO ───────────────────────────────

describe('S-10: recoverTransfer after PÉRDIDA+RECLAMO — old claim row immutable', () => {
  it('creates a recovery row referencing a claim loss row', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const oldId = await seedLossRow({ claimOpen: true });

    const result = await recoverTransfer(oldId, 50);

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ recovery_of_id: string }>(
      `SELECT recovery_of_id FROM transfer_reconciliations WHERE recovery_of_id = $1`,
      [oldId],
    );

    expect(rows.rows).toHaveLength(1);
  });

  it('old claim row remains with claim_open=true after recovery', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const oldId = await seedLossRow({ claimOpen: true });

    await recoverTransfer(oldId, 50);

    const [row] = await pg.query<{ claim_open: boolean; status: string }>(
      `SELECT claim_open, status FROM transfer_reconciliations WHERE id = $1`,
      [oldId],
    ).then(r => r.rows);

    expect(row?.claim_open).toBe(true);
    expect(row?.status).toBe('resolved');
  });
});

// ── FIX 2: resolveTransfer current-status guard ───────────────────────────────
// resolveTransfer may only close an investigable row (not_arrived / mismatch).
// Resolving an already-`resolved` row (replay) or flipping a `confirmed` row to
// loss WITHOUT clawing back its deposit must be rejected.

describe('FIX 2: resolveTransfer rejects non-investigable statuses', () => {
  it('rejects resolving an already-resolved (terminal) row', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedLossRow();

    const result = await resolveTransfer(id, 'loss');

    expect(result.ok).toBe(false);
  });

  it('rejects resolving a CONFIRMED row to loss (would not claw back the deposit)', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    counter++;
    const id = UUID(counter);
    await pg.query(
      `INSERT INTO transfer_reconciliations
         (id, organization_id, method, expected_amount, arrived_amount, status)
       VALUES ($1, $2, 'Transferencia', '100.00', '100.00', 'confirmed')`,
      [id, ORG],
    );

    const result = await resolveTransfer(id, 'loss');

    expect(result.ok).toBe(false);

    // The row must remain confirmed — never silently flipped to a loss.
    const row = await pg.query<{ status: string; resolution_type: string | null }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(row.rows[0]?.status).toBe('confirmed');
    expect(row.rows[0]?.resolution_type).toBeNull();
  });

  it('still allows resolving a mismatch row', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    counter++;
    const id = UUID(counter);
    await pg.query(
      `INSERT INTO transfer_reconciliations
         (id, organization_id, method, expected_amount, arrived_amount, status)
       VALUES ($1, $2, 'Transferencia', '100.00', '40.00', 'mismatch')`,
      [id, ORG],
    );

    const result = await resolveTransfer(id, 'loss');

    expect(result.ok).toBe(true);
  });
});

// ── S-22: recoverTransfer on non-loss row — rejected ──────────────────────────

describe('S-22: recoverTransfer rejects non-loss rows in the action layer', () => {
  it('returns error when trying to recover a cashier_liability row', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const cashierRowId = await seedResolvedCashierLiability();

    const result = await recoverTransfer(cashierRowId, 200);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatch(/pérdida|loss|recuperación|recovery/i);
    }
  });

  it('returns error when trying to recover a not_arrived row', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const notArrivedId = await seedNotArrived();

    const result = await recoverTransfer(notArrivedId, 100);

    expect(result.ok).toBe(false);
  });
});
