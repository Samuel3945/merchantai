/**
 * PR6 — POS close route: block-close guard tests (Strict TDD — RED first)
 *
 * Scenarios covered:
 *   S-16: Toggle A OFF — close succeeds even with not_arrived rows
 *   S-17: Toggle A ON — close blocked when not_arrived rows exist
 *   S-18: Toggle A ON — close allowed when no not_arrived rows
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './close/route';

// ── Hoisted state ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  authCtx: null as Record<string, unknown> | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/pos-auth', () => ({
  requirePosAuth: vi.fn(async () => ({ ctx: h.authCtx, errorResponse: null })),
}));

vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  logAction: vi.fn(async () => {}),
}));

const ORG = 'org_block_guard_test';
const TOKEN = '55555555-5555-5555-5555-555555555555';
const SESSION = '66666666-6666-6666-6666-666666666666';

const SCHEMA = `
  CREATE TYPE "cash_session_status" AS ENUM('open', 'closed');
  CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','fiado_payment','reclassification');
  CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito');
  CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover');
  CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch', 'resolved');
  CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability');

  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL,
    allow_oversell boolean DEFAULT false NOT NULL,
    default_sweep_destination_account_id uuid
  );

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

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    type "treasury_account_type" NOT NULL,
    name text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    payment_method_id uuid,
    pos_token_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_accounts_org_name_unique UNIQUE (organization_id, name)
  );

  CREATE TABLE treasury_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account_id uuid,
    to_account_id uuid,
    amount numeric(12,2) NOT NULL,
    type "treasury_movement_type" NOT NULL,
    category text,
    reason text,
    expense_id uuid,
    transfer_reconciliation_id uuid,
    handover_movement_id uuid,
    cash_session_id uuid,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_mov_one_external CHECK (
      num_nonnulls(from_account_id, to_account_id) = 2
      OR (
        num_nonnulls(from_account_id, to_account_id) = 1
        AND type IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
      )
    )
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

async function seedOpenSession(id: string): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, $3, 'cajero', '0', 'open')`,
    [id, ORG, TOKEN],
  );
}

async function seedNotArrived(orgId = ORG): Promise<void> {
  await pg.query(
    `INSERT INTO transfer_reconciliations
       (id, organization_id, method, expected_amount, status)
     VALUES (gen_random_uuid(), $1, 'Transferencia', '100.00', 'not_arrived')`,
    [orgId],
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

function closeRequest(countedAmount: number): Request {
  return new Request('http://localhost/api/pos/cash/close', {
    method: 'POST',
    body: JSON.stringify({ countedAmount }),
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    `TRUNCATE transfer_reconciliations;
     TRUNCATE treasury_movements;
     TRUNCATE treasury_accounts;
     TRUNCATE cash_movements;
     TRUNCATE cash_sessions;
     TRUNCATE pos_tokens;
     TRUNCATE app_settings;`,
  );
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
    [TOKEN, ORG],
  );
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Cajero',
    source: 'token',
    tokenId: TOKEN,
    cashierId: null,
  };
});

// ── S-16: Toggle A OFF — close succeeds with open investigations ──────────────

describe('S-16: Toggle A OFF — POS close succeeds even with not_arrived rows', () => {
  it('closes successfully when toggle is absent (default OFF) and not_arrived rows exist', async () => {
    await seedOpenSession(SESSION);
    await seedNotArrived();
    // No app_settings row → toggle OFF by default

    const res = await POST(closeRequest(0));

    expect(res.status).toBe(200);
  });

  it('closes successfully when toggle is "false" and not_arrived rows exist', async () => {
    await seedOpenSession(SESSION);
    await seedNotArrived();
    await pg.query(
      `INSERT INTO app_settings (organization_id, key, value)
       VALUES ($1, 'transfer-block-close-on-investigation', 'false')`,
      [ORG],
    );

    const res = await POST(closeRequest(0));

    expect(res.status).toBe(200);
  });
});

// ── S-17: Toggle A ON — close blocked with open investigations ────────────────

describe('S-17: Toggle A ON — POS close blocked when not_arrived rows exist', () => {
  it('returns 400 with investigation error when toggle=ON and not_arrived rows exist', async () => {
    await enableBlockCloseToggle();
    await seedOpenSession(SESSION);
    await seedNotArrived();

    const res = await POST(closeRequest(0));

    expect(res.status).toBe(400);

    const body = await res.json() as { error?: string };

    expect(body.error).toMatch(/investigaci[oó]n|not_arrived|pendiente/i);
  });

  it('session remains open after a blocked close', async () => {
    await enableBlockCloseToggle();
    await seedOpenSession(SESSION);
    await seedNotArrived();

    await POST(closeRequest(0));

    const rows = await pg.query<{ status: string }>(
      `SELECT status FROM cash_sessions WHERE id = $1`,
      [SESSION],
    );

    expect(rows.rows[0]?.status).toBe('open');
  });
});

// ── S-18: Toggle A ON — close allowed when no open investigations ─────────────

describe('S-18: Toggle A ON — POS close allowed when no not_arrived rows', () => {
  it('closes successfully when toggle=ON but no not_arrived rows exist', async () => {
    await enableBlockCloseToggle();
    await seedOpenSession(SESSION);
    // No not_arrived rows

    const res = await POST(closeRequest(0));

    expect(res.status).toBe(200);
  });

  it('closes even when only resolved rows exist (not not_arrived)', async () => {
    await enableBlockCloseToggle();
    await seedOpenSession(SESSION);
    await pg.query(
      `INSERT INTO transfer_reconciliations
         (id, organization_id, method, expected_amount, status, resolution_type,
          resolved_by, resolved_at)
       VALUES (gen_random_uuid(), $1, 'Transferencia', '100.00', 'resolved', 'loss',
               'admin', now())`,
      [ORG],
    );

    const res = await POST(closeRequest(0));

    expect(res.status).toBe(200);
  });
});
