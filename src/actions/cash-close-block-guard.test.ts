/**
 * Panel-surface block-close guard tests (Strict TDD)
 *
 * Parity with the POS route guard (api/pos/cash/close-block-guard.test.ts):
 * closeCashSession (the dashboard/panel close) must honor toggle A
 * (transfer-block-close-on-investigation) using the SAME shared helper so both
 * surfaces always agree.
 *
 * Scenarios:
 *   Toggle A OFF — close succeeds even with not_arrived rows
 *   Toggle A ON  — close blocked when not_arrived rows exist (session stays open)
 *   Toggle A ON  — close allowed when no not_arrived rows exist
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted state ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgId: 'org_panel_block_guard',
  userId: 'user_owner',
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: h.userId, orgId: h.orgId })),
  currentUser: vi.fn(async () => ({ fullName: 'Owner' })),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('./notifications', () => ({
  notifyCashDifference: vi.fn(async () => {}),
}));

// Keep the real cash-helpers (findOpenSession, toMoney, the block-close path)
// but stub the expected-amount computation so we don't need the full cash
// breakdown query tree — this test is about the block-close guard only.
vi.mock('@/libs/cash-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/cash-helpers')>();
  return {
    ...actual,
    computeExpectedAmount: vi.fn(async () => 0),
  };
});

const ORG = 'org_panel_block_guard';
const SESSION = '77777777-7777-7777-7777-777777777777';

const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved');
  CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability');

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_at timestamp DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    closed_at timestamp,
    closed_by text,
    opened_by_actor_id text,
    closed_by_actor_id text,
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

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );
`;

let pg: PGlite;

async function seedOpenSession(): Promise<void> {
  // pos_token_id NULL = the admin/panel session that closeCashSession closes.
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, NULL, 'owner', '0', 'open')`,
    [SESSION, ORG],
  );
}

async function seedNotArrived(): Promise<void> {
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES (gen_random_uuid(), $1, 'Transferencia', '100.00', 'not_arrived')`,
    [ORG],
  );
}

async function enableBlockCloseToggle(): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value)
     VALUES ($1, 'transfer-block-close-on-investigation', 'true')
     ON CONFLICT (organization_id, key) DO UPDATE SET value = 'true'`,
    [ORG],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    `TRUNCATE transfer_reconciliations;
     TRUNCATE cash_sessions;
     TRUNCATE app_settings;`,
  );
  vi.clearAllMocks();
});

describe('closeCashSession — toggle A OFF closes even with open investigations', () => {
  it('closes when toggle is absent (default OFF) and not_arrived rows exist', async () => {
    const { closeCashSession } = await import('./cash');
    await seedOpenSession();
    await seedNotArrived();

    const result = await closeCashSession(0);

    expect(result.ok).toBe(true);

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM cash_sessions WHERE id = $1`,
      [SESSION],
    );

    expect(rows.rows[0]?.status).toBe('closed');
  });
});

describe('closeCashSession — toggle A ON blocks close with open investigations', () => {
  it('rejects the close when toggle=ON and not_arrived rows exist', async () => {
    const { closeCashSession } = await import('./cash');
    await enableBlockCloseToggle();
    await seedOpenSession();
    await seedNotArrived();

    const result = await closeCashSession(0);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatch(/investigaci[oó]n|pendiente/i);
    }
  });

  it('leaves the session open after a blocked close', async () => {
    const { closeCashSession } = await import('./cash');
    await enableBlockCloseToggle();
    await seedOpenSession();
    await seedNotArrived();

    await closeCashSession(0);

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM cash_sessions WHERE id = $1`,
      [SESSION],
    );

    expect(rows.rows[0]?.status).toBe('open');
  });
});

describe('closeCashSession — toggle A ON allows close when no investigations', () => {
  it('closes when toggle=ON but no not_arrived rows exist', async () => {
    const { closeCashSession } = await import('./cash');
    await enableBlockCloseToggle();
    await seedOpenSession();

    const result = await closeCashSession(0);

    expect(result.ok).toBe(true);
  });
});
