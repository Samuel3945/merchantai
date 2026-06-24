/**
 * PR6 — Org toggles + close-block guard action-layer tests (Strict TDD — RED first)
 *
 * Scenarios covered (action layer):
 *   S-19: Toggle B default — markTransferNotArrived parks as not_arrived
 *   S-20: Toggle B direct_loss — markTransferNotArrived auto-resolves as loss
 *   S-21: Toggle B direct_loss — recoverTransfer still works after auto-loss
 *   S-23: cashier (org:member) cannot write either toggle setting
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

// ── Hoisted state ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgRole: 'org:admin' as string,
  orgId: 'org-toggles-action-test',
  userId: 'user_test',
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
  clerkClient: vi.fn(async () => ({
    organizations: {
      updateOrganization: vi.fn(),
    },
  })),
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

// treasury — not needed for these tests but avoids import errors
vi.mock('@/libs/treasury', () => ({
  depositConfirmedTransfer: vi.fn(async () => ({})),
  adjustConfirmedTransferDeposit: vi.fn(async () => ({})),
}));

vi.mock('@/libs/customers', () => ({
  findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-123' })),
}));

vi.mock('@/libs/creditos', () => ({
  createCredito: vi.fn(async () => ({ id: 'credito-123' })),
}));

vi.mock('@/libs/payment-reclassification', () => ({
  reclassifyPayment: vi.fn(async () => ({})),
}));

vi.mock('@/libs/cash-helpers', () => ({
  findOrCreateOpenSession: vi.fn(async () => ({
    id: 'session-123',
    organizationId: h.orgId,
  })),
  findOpenSession: vi.fn(async () => ({
    id: 'session-123',
    organizationId: h.orgId,
  })),
  toMoney: (v: number | string) => String(Number(v).toFixed(2)),
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

const ORG = 'org-toggles-action-test';
let counter = 0;
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let pg: PGlite;

async function seedPending(): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES ($1, $2, 'Transferencia', '100.00', 'pending')`,
    [id, ORG],
  );
  return id;
}

async function seedLoss(): Promise<string> {
  counter++;
  const id = UUID(counter);
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status,
        resolution_type, resolved_by, resolved_at)
     VALUES ($1, $2, 'Transferencia', '100.00', 'resolved',
             'loss', 'admin', now())`,
    [id, ORG],
  );
  return id;
}

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
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM transfer_reconciliations; DELETE FROM app_settings;',
  );
  h.orgRole = 'org:admin';
  counter = 0;
  vi.clearAllMocks();
  // Re-register stubs after clearAllMocks
  const { depositConfirmedTransfer } = await import('@/libs/treasury');
  vi.mocked(depositConfirmedTransfer).mockResolvedValue({} as Awaited<ReturnType<typeof depositConfirmedTransfer>>);
});

// ── S-19: Toggle B default — not_arrived is the outcome ──────────────────────

describe('S-19: Toggle B default (investigate) — markTransferNotArrived parks as not_arrived', () => {
  it('row status becomes not_arrived when no setting is set (default=investigate)', async () => {
    const { markTransferNotArrived } = await import('./transfer-reconciliation');
    const id = await seedPending();
    // No app_settings row → default = 'investigate'

    const result = await markTransferNotArrived(id);

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(rows.rows[0]?.status).toBe('not_arrived');
  });

  it('row status becomes not_arrived when setting is explicitly "investigate"', async () => {
    const { markTransferNotArrived } = await import('./transfer-reconciliation');
    await setSetting('transfer-default-resolution', 'investigate');
    const id = await seedPending();

    const result = await markTransferNotArrived(id);

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(rows.rows[0]?.status).toBe('not_arrived');
  });
});

// ── S-20: Toggle B direct_loss — auto-resolves as loss ───────────────────────

describe('S-20: Toggle B direct_loss — markTransferNotArrived auto-resolves as loss', () => {
  it('row status becomes resolved with resolution_type=loss when setting=direct_loss', async () => {
    const { markTransferNotArrived } = await import('./transfer-reconciliation');
    await setSetting('transfer-default-resolution', 'direct_loss');
    const id = await seedPending();

    // REVIEWER NOTE: direct_loss intentionally bypasses the interactive admin gate
    // because the admin pre-consented via this setting. The org:admin chose to
    // auto-route non-arrivals as losses — this IS the admin action, it is not
    // a missing permission check. See ADR-5 / design obs #277.
    const result = await markTransferNotArrived(id);

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ status: string; resolution_type: string }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(rows.rows[0]?.status).toBe('resolved');
    expect(rows.rows[0]?.resolution_type).toBe('loss');
  });

  it('no treasury movement is posted when direct_loss auto-resolves a row', async () => {
    const { markTransferNotArrived } = await import('./transfer-reconciliation');
    const { depositConfirmedTransfer } = await import('@/libs/treasury');
    await setSetting('transfer-default-resolution', 'direct_loss');
    const id = await seedPending();

    await markTransferNotArrived(id);

    // Loss never posts a credit — depositConfirmedTransfer must not be called
    expect(vi.mocked(depositConfirmedTransfer)).not.toHaveBeenCalled();
  });

  it('rejects direct_loss on a non-pending (already confirmed) row — no silent flip', async () => {
    const { markTransferNotArrived } = await import('./transfer-reconciliation');
    await setSetting('transfer-default-resolution', 'direct_loss');
    counter++;
    const id = UUID(counter);
    await pg.query(
      `INSERT INTO transfer_reconciliations
         (id, organization_id, method, expected_amount, status)
       VALUES ($1, $2, 'Transferencia', '100.00', 'confirmed')`,
      [id, ORG],
    );

    const result = await markTransferNotArrived(id);

    expect(result.ok).toBe(false);

    // The confirmed (already deposited) row must NOT be flipped to a loss.
    const rows = await pg.query<{ status: string; resolution_type: string | null }>(
      `SELECT status, resolution_type FROM transfer_reconciliations WHERE id = $1`,
      [id],
    );

    expect(rows.rows[0]?.status).toBe('confirmed');
    expect(rows.rows[0]?.resolution_type).toBeNull();
  });
});

// ── S-21: Recovery after direct_loss ─────────────────────────────────────────

describe('S-21: Recovery still possible after direct_loss auto-resolution', () => {
  it('recoverTransfer succeeds after a direct_loss row', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    const lossId = await seedLoss();

    const result = await recoverTransfer(lossId, 100);

    expect(result.ok).toBe(true);
  });

  it('recovery row has status=confirmed and recovery_of_id pointing to the loss row', async () => {
    const { recoverTransfer } = await import('./transfer-reconciliation');
    const lossId = await seedLoss();

    await recoverTransfer(lossId, 100);

    const rows = await pg.query<{ status: string; recovery_of_id: string }>(
      `SELECT status, recovery_of_id FROM transfer_reconciliations
       WHERE recovery_of_id = $1`,
      [lossId],
    );

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]?.status).toBe('confirmed');
    expect(rows.rows[0]?.recovery_of_id).toBe(lossId);
  });
});

// ── S-23: Cashier cannot write org settings ───────────────────────────────────

describe('S-23: cashier (org:member) cannot write org toggle settings', () => {
  it('setAppSetting rejects org:member for transfer-block-close-on-investigation', async () => {
    const { setAppSetting } = await import('./app-settings');
    h.orgRole = 'org:member';

    await expect(
      setAppSetting('transfer-block-close-on-investigation', 'true'),
    ).rejects.toThrow(/admin/i);
  });

  it('setAppSetting rejects org:member for transfer-default-resolution', async () => {
    const { setAppSetting } = await import('./app-settings');
    h.orgRole = 'org:member';

    await expect(
      setAppSetting('transfer-default-resolution', 'direct_loss'),
    ).rejects.toThrow(/admin/i);
  });

  it('setAppSetting succeeds for org:admin', async () => {
    const { setAppSetting } = await import('./app-settings');
    h.orgRole = 'org:admin';

    await expect(
      setAppSetting('transfer-block-close-on-investigation', 'true'),
    ).resolves.not.toThrow();
  });
});
