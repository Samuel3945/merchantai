/**
 * PR2 — Permission gate tests (action layer)
 *
 * Strict TDD: RED tests written before the admin gate implementation.
 * These tests simulate a cashier (org:member with cash module) attempting
 * admin-only operations to confirm the permission gate rejects them.
 *
 * Scenarios covered:
 *   S-12: cashier cannot mark PÉRDIDA (loss)
 *   S-13: cashier cannot mark CARGO A CAJERO (cashier_liability)
 *   S-14: cashier cannot trigger RECUPERACIÓN (recoverTransfer — future PR5 action)
 *   S-15: cashier CAN resolve FIADO (receivable) — gate must NOT fire
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

// ── Hoisted state (vi.hoisted runs before module resolution) ──────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgRole: 'org:admin' as string,
  orgId: 'org-perm-test',
  userId: 'user_test',
}));

// Mock the shared DB instance that actions/transfer-reconciliation.ts imports
vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

// Mock Clerk auth so we can control orgRole per test
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
    orgRole: h.orgRole,
  })),
  currentUser: vi.fn(async () => ({ fullName: 'Test User' })),
}));

// Mock requirePanelModule: if org:admin → pass through; if org:member → simulate
// a cashier who has the cash module (module check passes, role gate is what we test).
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

// ── Minimal PGLite schema for transfer_reconciliations ────────────────────────

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

const ORG = 'org-perm-test';

let counter = 0;
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let pg: PGlite;

async function seedNotArrived(): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES ($1, $2, 'Transferencia', '100.00', 'not_arrived')`,
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
  h.orgRole = 'org:admin';
});

// ── S-12: Cashier cannot mark PÉRDIDA (loss) ─────────────────────────────────

describe('S-12: admin-only gate — cashier cannot resolve as loss', () => {
  it('returns a permission error when org:member tries to mark loss', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:member';
    const id = await seedNotArrived();

    const result = await resolveTransfer(id, 'loss');

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatch(/propietario|admin/i);
    }
  });

  it('leaves the row status unchanged after permission denial on loss', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:member';
    const id = await seedNotArrived();

    await resolveTransfer(id, 'loss');

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(rows.rows[0]?.status).toBe('not_arrived');
  });
});

// ── S-13: Cashier cannot mark CARGO A CAJERO (cashier_liability) ─────────────

describe('S-13: admin-only gate — cashier cannot resolve as cashier_liability', () => {
  it('returns a permission error when org:member tries to mark cashier_liability', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:member';
    const id = await seedNotArrived();

    const result = await resolveTransfer(id, 'cashier_liability');

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatch(/propietario|admin/i);
    }
  });

  it('leaves the row status unchanged after permission denial on cashier_liability', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:member';
    const id = await seedNotArrived();

    await resolveTransfer(id, 'cashier_liability');

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(rows.rows[0]?.status).toBe('not_arrived');
  });
});

// ── S-14: Cashier cannot trigger RECUPERACIÓN (recoverTransfer) ───────────────
// Un-skipped in PR5 now that recoverTransfer is implemented with the admin gate.

describe('S-14: admin-only gate — cashier cannot trigger recoverTransfer', () => {
  it('recoverTransfer must exist and reject org:member with a permission error', async () => {
    const actions = await import('./transfer-reconciliation') as Record<string, unknown>;
    h.orgRole = 'org:member';

    const recoverTransfer = actions.recoverTransfer as
      | ((lossId: string, amount?: number) => Promise<{ ok: boolean; error?: string }>)
      | undefined;

    expect(recoverTransfer).toBeDefined();

    if (recoverTransfer) {
      const result = await recoverTransfer(UUID(999));

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/propietario|admin/i);
    }
  });
});

// ── S-15: Cashier CAN resolve FIADO (receivable) ─────────────────────────────
// The admin gate must NOT fire for resolutionType='receivable'.
// The action will still fail (no salePaymentId on the row), but the error
// MUST be a business-logic validation, not a permission error.

describe('S-15: cashier permission — FIADO resolution is cashier-level', () => {
  it('does not return a permission error when org:member resolves as receivable', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:member';
    const id = await seedNotArrived();

    const result = await resolveTransfer(id, 'receivable');

    // Action fails for a business reason (no salePaymentId), NOT permission.

    expect(result.ok).toBe(false);

    if (!result.ok) {
      // Must NOT be a permission error
      expect(result.error).not.toMatch(/propietario|admin/i);
      // Should be the business guard for missing sale link
      expect(result.error).toMatch(/venta|fiado|saldo|cliente/i);
    }
  });

  it('admin resolving as receivable hits the same business check, not permission', async () => {
    const { resolveTransfer } = await import('./transfer-reconciliation');
    h.orgRole = 'org:admin';
    const id = await seedNotArrived();

    const result = await resolveTransfer(id, 'receivable');

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).not.toMatch(/propietario|admin/i);
    }
  });
});
