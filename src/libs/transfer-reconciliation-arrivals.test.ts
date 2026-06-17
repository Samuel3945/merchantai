/**
 * PR4 — Axis-1 arrival paths (lib layer, Strict TDD)
 *
 * RED tests written BEFORE the implementation.
 *
 * Scenarios covered:
 *   S-02: Late full arrival (not_arrived → confirmed + treasury credit link)
 *   S-03: Partial arrival conservation law + remainder row creation
 *   S-03b: Invalid partial amounts rejected
 *
 * All tests run against the PGLite in-memory engine to avoid I/O.
 * The treasury deposit (depositConfirmedTransfer) is NOT called here —
 * that lives in the action layer. The lib only handles the row mutations.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmReconciliation,
  listReconciliations,
  splitPartialArrival,
} from '@/libs/transfer-reconciliation';
import { transferReconciliationsSchema } from '@/models/Schema';

// ── PGlite-backed integration tests ──────────────────────────────────────────

type Executor = Parameters<typeof confirmReconciliation>[0];

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
`;

const ORG = 'org-arrivals';
const USER = 'Dueño';
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let counter = 0;

async function seed(overrides: Record<string, unknown> = {}): Promise<string> {
  counter++;
  const id = UUID(counter);
  await db.insert(transferReconciliationsSchema).values({
    id,
    organizationId: ORG,
    method: 'Transferencia',
    expectedAmount: '100.00',
    status: 'pending',
    ...overrides,
  } as any);
  return id;
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
  await pg.exec('DELETE FROM transfer_reconciliations');
  counter = 0;
});

// ── S-02: Late full arrival (not_arrived → confirmed) ─────────────────────────
// The existing confirmReconciliation already handles this transition.
// These tests verify the late-arrival path works from not_arrived status.

describe('S-02: Late full arrival (not_arrived → confirmed)', () => {
  it('moves status to confirmed when confirming a not_arrived row', async () => {
    const id = await seed({ status: 'not_arrived' });
    const row = await confirmReconciliation(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
    });

    expect(row?.status).toBe('confirmed');
    expect(row?.arrivedAmount).toBe('100.00');
    expect(row?.reconciledBy).toBe(USER);
    expect(row?.reconciledAt).not.toBeNull();
  });

  it('sets arrivedAmount to expectedAmount when no amount provided', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '250.00' });
    const row = await confirmReconciliation(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
    });

    expect(row?.arrivedAmount).toBe('250.00');
  });

  it('removes the row from the investigation list after confirming', async () => {
    await seed({ status: 'not_arrived' });
    const id2 = await seed({ status: 'not_arrived' });

    await confirmReconciliation(db, {
      id: id2,
      organizationId: ORG,
      reconciledBy: USER,
    });

    const investigations = await listReconciliations(db, {
      organizationId: ORG,
      status: 'not_arrived',
    });

    expect(investigations).toHaveLength(1);
    expect(investigations[0]?.id).not.toBe(id2);
  });

  it('confirms even when an explicit arrived amount is provided', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '200.00' });
    const row = await confirmReconciliation(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 200,
    });

    expect(row?.status).toBe('confirmed');
    expect(row?.arrivedAmount).toBe('200.00');
  });
});

// ── S-03: Partial arrival — conservation law + remainder creation ───────────
// The new splitPartialArrival lib function must:
//   1. Set original.status = 'resolved', original.arrived_amount = X
//   2. Insert a NEW row with status = 'not_arrived', expected_amount = original.expected - X
//   3. Set original.remainder_reconciliation_id = new_row.id
//   4. Conservation: arrived + remainder.expected === original.expected (no money created/destroyed)

describe('S-03: Partial arrival — splitPartialArrival', () => {
  it('sets original row to resolved with arrived_amount', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 60,
    });

    expect(result.original.status).toBe('resolved');
    expect(result.original.arrivedAmount).toBe('60.00');
  });

  it('creates a new not_arrived remainder row for the shortfall', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 60,
    });

    expect(result.remainder.status).toBe('not_arrived');
    expect(result.remainder.expectedAmount).toBe('40.00');
  });

  it('links original.remainder_reconciliation_id to the new row id', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 60,
    });

    expect(result.original.remainderReconciliationId).toBe(result.remainder.id);
  });

  it('CONSERVATION LAW: arrived + remainder.expected === original.expected', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 60,
    });

    const arrived = Number.parseFloat(result.original.arrivedAmount ?? '0');
    const remainder = Number.parseFloat(result.remainder.expectedAmount);
    const original = Number.parseFloat('100.00');

    expect(arrived + remainder).toBeCloseTo(original, 2);
  });

  it('CONSERVATION LAW: works with non-round amounts', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 33.33,
    });

    const arrived = Number.parseFloat(result.original.arrivedAmount ?? '0');
    const remainder = Number.parseFloat(result.remainder.expectedAmount);
    const original = Number.parseFloat('100.00');

    expect(arrived + remainder).toBeCloseTo(original, 2);
  });

  it('remainder row inherits organization_id and method from original', async () => {
    const id = await seed({
      status: 'not_arrived',
      expectedAmount: '100.00',
      method: 'Nequi',
    });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 40,
    });

    expect(result.remainder.organizationId).toBe(ORG);
    expect(result.remainder.method).toBe('Nequi');
  });

  it('original row is absent from the investigation list after split', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 60,
    });

    const investigations = await listReconciliations(db, {
      organizationId: ORG,
      status: 'not_arrived',
    });

    expect(investigations.every(r => r.id !== id)).toBe(true);
  });

  it('remainder row appears in the investigation list', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 60,
    });

    const investigations = await listReconciliations(db, {
      organizationId: ORG,
      status: 'not_arrived',
    });

    expect(investigations).toHaveLength(1);
    expect(investigations[0]?.id).toBe(result.remainder.id);
  });

  it('copies sale_payment_id from original to the remainder row', async () => {
    const salePaymentId = UUID(999);
    const id = await seed({
      status: 'not_arrived',
      expectedAmount: '100.00',
      salePaymentId,
    });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 50,
    });

    expect(result.remainder.salePaymentId).toBe(salePaymentId);
  });

  it('does not touch another org row (tenant isolation)', async () => {
    const OTHER = 'org-other';
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });

    await expect(
      splitPartialArrival(db, {
        id,
        organizationId: OTHER,
        reconciledBy: USER,
        arrivedAmount: 60,
      }),
    ).rejects.toThrow();
  });
});

// ── S-03b: Partial arrival — invalid amounts rejected ─────────────────────────

describe('S-03b: Partial arrival — invalid amounts', () => {
  it('rejects arrived_amount === 0', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });

    await expect(
      splitPartialArrival(db, {
        id,
        organizationId: ORG,
        reconciledBy: USER,
        arrivedAmount: 0,
      }),
    ).rejects.toThrow();
  });

  it('rejects arrived_amount === expected_amount (should use late-full instead)', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });

    await expect(
      splitPartialArrival(db, {
        id,
        organizationId: ORG,
        reconciledBy: USER,
        arrivedAmount: 100,
      }),
    ).rejects.toThrow();
  });

  it('rejects arrived_amount greater than expected_amount', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });

    await expect(
      splitPartialArrival(db, {
        id,
        organizationId: ORG,
        reconciledBy: USER,
        arrivedAmount: 150,
      }),
    ).rejects.toThrow();
  });

  it('rejects negative arrived_amount', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });

    await expect(
      splitPartialArrival(db, {
        id,
        organizationId: ORG,
        reconciledBy: USER,
        arrivedAmount: -10,
      }),
    ).rejects.toThrow();
  });
});

// ── S-03: Partial arrival — remainder row has no resolution fields ────────────

describe('S-03: remainder row carries no resolution fields', () => {
  it('remainder row has no resolution_type, claim_open defaults false, no recovery_of_id', async () => {
    const id = await seed({ status: 'not_arrived', expectedAmount: '100.00' });
    const result = await splitPartialArrival(db, {
      id,
      organizationId: ORG,
      reconciledBy: USER,
      arrivedAmount: 70,
    });

    expect(result.remainder.resolutionType).toBeNull();
    expect(result.remainder.claimOpen).toBe(false);
    expect(result.remainder.recoveryOfId).toBeNull();
    expect(result.remainder.remainderReconciliationId).toBeNull();
  });
});
