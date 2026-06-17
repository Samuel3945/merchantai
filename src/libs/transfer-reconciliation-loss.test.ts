/**
 * PR5 — Loss + reclamo + cross-period recovery (lib layer, Strict TDD)
 *
 * RED tests written BEFORE the implementation.
 *
 * Scenarios covered:
 *   S-06: PÉRDIDA — no treasury movement created (the core invariant)
 *   S-07: PÉRDIDA+RECLAMO — same money routing + claim_open=true
 *   S-08: CARGO A CAJERO — no treasury movement created
 *   S-09: Recovery after PÉRDIDA — new confirmed row referencing old loss
 *   S-10: Recovery after PÉRDIDA+RECLAMO — same, old row immutable
 *   S-22: Recovery on a non-loss row — rejected with validation error
 *
 * All tests run against PGLite in-memory. treasury_movements is seeded as a
 * minimal table so we can assert zero rows are written during loss/liability.
 * depositConfirmedTransfer IS called in recovery (via createRecoveryReconciliation).
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRecoveryReconciliation,
  setReconciliationResolution,
} from '@/libs/transfer-reconciliation';
import { transferReconciliationsSchema } from '@/models/Schema';

// ── PGlite-backed integration tests ──────────────────────────────────────────

type Executor = Parameters<typeof setReconciliationResolution>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
];

const DDL = `
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

  CREATE TABLE treasury_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    type text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-loss-test';
const USER = 'Admin';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;

async function seedNotArrived(overrides: Record<string, unknown> = {}): Promise<string> {
  counter++;
  const id = UUID(counter);
  await db.insert(transferReconciliationsSchema).values({
    id,
    organizationId: ORG,
    method: 'Transferencia',
    expectedAmount: '100.00',
    status: 'not_arrived',
    ...overrides,
  } as any);
  return id;
}

async function seedResolved(overrides: Record<string, unknown> = {}): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status, resolution_type, resolved_by, resolved_at)
     VALUES ($1, $2, $3, $4, 'resolved', $5, $6, now())`,
    [
      id,
      ORG,
      (overrides.method as string) ?? 'Transferencia',
      (overrides.expectedAmount as string) ?? '100.00',
      (overrides.resolutionType as string) ?? 'loss',
      USER,
    ],
  );
  if (overrides.claimOpen) {
    await pg.query(
      `UPDATE transfer_reconciliations SET claim_open = true WHERE id = $1`,
      [id],
    );
  }
  return id;
}

async function countTreasuryMovements(): Promise<number> {
  const result = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM treasury_movements WHERE organization_id = $1`,
    [ORG],
  );
  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;

  for (const e of ENUMS) {
    await pg.exec(e);
  }

  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM transfer_reconciliations');
  counter = 0;
});

// ── S-06: PÉRDIDA — no treasury movement ─────────────────────────────────────

describe('S-06: PÉRDIDA — resolving as loss MUST NOT write any treasury movement', () => {
  it('sets status to resolved and resolution_type to loss', async () => {
    const id = await seedNotArrived();

    const row = await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'loss',
      resolvedBy: USER,
      status: 'resolved',
    });

    expect(row?.status).toBe('resolved');
    expect(row?.resolutionType).toBe('loss');
    expect(row?.claimOpen).toBe(false);
  });

  it('writes ZERO treasury_movements rows (the no-cash-loss invariant)', async () => {
    const id = await seedNotArrived();

    await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'loss',
      resolvedBy: USER,
      status: 'resolved',
    });

    const count = await countTreasuryMovements();

    expect(count).toBe(0);
  });

  it('removes the row from the not_arrived query', async () => {
    const id = await seedNotArrived();

    await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'loss',
      resolvedBy: USER,
      status: 'resolved',
    });

    const rows = await pg.query<{ id: string }>(
      `SELECT id FROM transfer_reconciliations WHERE status = 'not_arrived' AND organization_id = $1`,
      [ORG],
    );

    expect(rows.rows.map(r => r.id)).not.toContain(id);
  });
});

// ── S-07: PÉRDIDA+RECLAMO — same money routing, claim_open=true ──────────────

describe('S-07: PÉRDIDA+RECLAMO — identical money to PÉRDIDA, claim_open=true', () => {
  it('sets status resolved, resolution_type loss, claim_open true', async () => {
    const id = await seedNotArrived();

    const row = await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'loss',
      resolvedBy: USER,
      status: 'resolved',
      claimOpen: true,
    });

    expect(row?.status).toBe('resolved');
    expect(row?.resolutionType).toBe('loss');
    expect(row?.claimOpen).toBe(true);
  });

  it('writes ZERO treasury_movements rows (same no-cash-loss invariant)', async () => {
    const id = await seedNotArrived();

    await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'loss',
      resolvedBy: USER,
      status: 'resolved',
      claimOpen: true,
    });

    const count = await countTreasuryMovements();

    expect(count).toBe(0);
  });
});

// ── S-08: CARGO A CAJERO — no treasury movement ──────────────────────────────

describe('S-08: CARGO A CAJERO — no treasury movement posted', () => {
  it('sets status resolved and resolution_type cashier_liability', async () => {
    const id = await seedNotArrived({ expectedAmount: '200.00' });

    const row = await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'cashier_liability',
      resolvedBy: USER,
      status: 'resolved',
    });

    expect(row?.status).toBe('resolved');
    expect(row?.resolutionType).toBe('cashier_liability');
  });

  it('writes ZERO treasury_movements rows', async () => {
    const id = await seedNotArrived({ expectedAmount: '200.00' });

    await setReconciliationResolution(db, {
      id,
      organizationId: ORG,
      resolutionType: 'cashier_liability',
      resolvedBy: USER,
      status: 'resolved',
    });

    const count = await countTreasuryMovements();

    expect(count).toBe(0);
  });
});

// ── S-09: Recovery after PÉRDIDA (cross-period) ───────────────────────────────

describe('S-09: createRecoveryReconciliation — new confirmed row referencing old loss', () => {
  it('inserts a new row with status confirmed and recovery_of_id set', async () => {
    const oldLossId = await seedResolved({ resolutionType: 'loss' });

    const newRow = await createRecoveryReconciliation(db, {
      organizationId: ORG,
      recoveryOfId: oldLossId,
      method: 'Transferencia',
      amount: 100,
      createdBy: USER,
    });

    expect(newRow.status).toBe('confirmed');
    expect(newRow.recoveryOfId).toBe(oldLossId);
  });

  it('does NOT update the old loss row (immutability)', async () => {
    const oldLossId = await seedResolved({ resolutionType: 'loss' });

    // Snapshot the old row before recovery
    const [before] = await pg.query<{
      status: string;
      resolution_type: string;
      claim_open: boolean;
    }>(
      `SELECT status, resolution_type, claim_open FROM transfer_reconciliations WHERE id = $1`,
      [oldLossId],
    ).then(r => r.rows);

    await createRecoveryReconciliation(db, {
      organizationId: ORG,
      recoveryOfId: oldLossId,
      method: 'Transferencia',
      amount: 100,
      createdBy: USER,
    });

    const [after] = await pg.query<{
      status: string;
      resolution_type: string;
      claim_open: boolean;
    }>(
      `SELECT status, resolution_type, claim_open FROM transfer_reconciliations WHERE id = $1`,
      [oldLossId],
    ).then(r => r.rows);

    // Old row must be completely unchanged
    expect(after?.status).toBe(before?.status);
    expect(after?.resolution_type).toBe(before?.resolution_type);
    expect(after?.claim_open).toBe(before?.claim_open);
  });

  it('recovery row does NOT appear in the investigation list (not_arrived query)', async () => {
    const oldLossId = await seedResolved({ resolutionType: 'loss' });

    const newRow = await createRecoveryReconciliation(db, {
      organizationId: ORG,
      recoveryOfId: oldLossId,
      method: 'Transferencia',
      amount: 100,
      createdBy: USER,
    });

    const rows = await pg.query<{ id: string }>(
      `SELECT id FROM transfer_reconciliations WHERE status = 'not_arrived' AND organization_id = $1`,
      [ORG],
    );

    expect(rows.rows.map(r => r.id)).not.toContain(newRow.id);
  });
});

// ── S-10: Recovery after PÉRDIDA+RECLAMO ──────────────────────────────────────

describe('S-10: recovery after PÉRDIDA+RECLAMO — old row immutable, claim_open stays', () => {
  it('creates recovery row with recovery_of_id referencing claim row', async () => {
    const oldId = await seedResolved({ resolutionType: 'loss', claimOpen: true });

    const newRow = await createRecoveryReconciliation(db, {
      organizationId: ORG,
      recoveryOfId: oldId,
      method: 'Transferencia',
      amount: 50,
      createdBy: USER,
    });

    expect(newRow.recoveryOfId).toBe(oldId);
    expect(newRow.status).toBe('confirmed');
  });

  it('old claim row remains immutable (claim_open still true)', async () => {
    const oldId = await seedResolved({ resolutionType: 'loss', claimOpen: true });

    await createRecoveryReconciliation(db, {
      organizationId: ORG,
      recoveryOfId: oldId,
      method: 'Transferencia',
      amount: 50,
      createdBy: USER,
    });

    const [row] = await pg.query<{ claim_open: boolean; status: string }>(
      `SELECT claim_open, status FROM transfer_reconciliations WHERE id = $1`,
      [oldId],
    ).then(r => r.rows);

    expect(row?.claim_open).toBe(true);
    expect(row?.status).toBe('resolved');
  });
});

// ── S-22: Recovery on non-loss row — REJECTED ─────────────────────────────────

describe('S-22: createRecoveryReconciliation rejects non-loss rows', () => {
  it('throws when recovery_of_id references a cashier_liability row', async () => {
    const cashierRow = await seedResolved({ resolutionType: 'cashier_liability' });

    await expect(
      createRecoveryReconciliation(db, {
        organizationId: ORG,
        recoveryOfId: cashierRow,
        method: 'Transferencia',
        amount: 100,
        createdBy: USER,
      }),
    ).rejects.toThrow(/pérdida|loss|recuperación|recovery/i);
  });

  it('throws when recovery_of_id references a not_arrived row', async () => {
    const notArrivedId = await seedNotArrived();

    await expect(
      createRecoveryReconciliation(db, {
        organizationId: ORG,
        recoveryOfId: notArrivedId,
        method: 'Transferencia',
        amount: 100,
        createdBy: USER,
      }),
    ).rejects.toThrow(/pérdida|loss|recuperación|recovery/i);
  });

  it('throws when the referenced row does not exist', async () => {
    await expect(
      createRecoveryReconciliation(db, {
        organizationId: ORG,
        recoveryOfId: UUID(999),
        method: 'Transferencia',
        amount: 100,
        createdBy: USER,
      }),
    ).rejects.toThrow();
  });
});
