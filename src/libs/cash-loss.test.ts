/**
 * Strict TDD — cash-loss feature (placeHandoverAsLoss).
 *
 * placeHandoverAsLoss
 *   - creates a positive 'faltante' expense
 *   - drains the handover remaining
 *   - lowers computeNetProfit by the lost amount
 *   - over-placement guard (cannot lose more than remaining)
 */

import type {
  getTreasuryPosition,
} from '@/libs/treasury';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { placeHandoverAsLoss } from '@/libs/cash-loss';
import {
  getOrCreatePendingAccount,
  recordHandoverMovement,
} from '@/libs/treasury';

// ── PGLite DDL (mirrors treasury.test.ts exactly) ──────────────────────────

type Executor = Parameters<typeof getTreasuryPosition>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'credito_payment', 'reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
  `CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover')`,
];

const DDL = `
  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );

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

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    category text,
    authorized_by text,
    created_by text NOT NULL,
    sale_id uuid,
    supplier_id uuid,
    corrects_session_id uuid,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
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
    resolution_credito_id uuid,
    cashier_explanation text,
    cashier_explained_by text,
    cashier_explained_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX transfer_reconciliations_sale_payment_idx
    ON transfer_reconciliations (sale_payment_id)
    WHERE sale_payment_id IS NOT NULL;

  CREATE TABLE treasury_transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account text NOT NULL,
    to_account text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    note text,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE expenses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    amount numeric(12,2) NOT NULL,
    category text NOT NULL,
    description text,
    incurred_on date NOT NULL,
    created_by text,
    reverses_expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT expenses_reverses_expense_id_unique UNIQUE (reverses_expense_id)
  );

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    type "treasury_account_type" NOT NULL,
    name text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    payment_method_id uuid REFERENCES payment_methods(id) ON DELETE RESTRICT,
    pos_token_id uuid REFERENCES pos_tokens(id) ON DELETE SET NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_accounts_org_name_unique UNIQUE (organization_id, name)
  );

  CREATE TABLE treasury_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    from_account_id uuid REFERENCES treasury_accounts(id) ON DELETE RESTRICT,
    to_account_id uuid REFERENCES treasury_accounts(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    type "treasury_movement_type" NOT NULL,
    category text,
    reason text,
    expense_id uuid REFERENCES expenses(id) ON DELETE RESTRICT,
    transfer_reconciliation_id uuid REFERENCES transfer_reconciliations(id) ON DELETE RESTRICT,
    handover_movement_id uuid REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT treasury_mov_one_external CHECK (
      num_nonnulls(from_account_id, to_account_id) = 2
      OR (
        num_nonnulls(from_account_id, to_account_id) = 1
        AND type::text IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
      )
    ),
    CONSTRAINT treasury_mov_transfer_recon_unique UNIQUE (transfer_reconciliation_id)
  );
`;

// Fixed UUIDs
const ORG = 'org-loss-test';
const TOKEN_ID = '00000000-0000-0000-0000-000000000aa1';
const SESSION_ID = '00000000-0000-0000-0000-000000000bb1';

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Executor;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  // FK deletion order: children before parents
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM payment_methods');
  await pg.exec('DELETE FROM treasury_transfers');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM app_settings');
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedPosSession() {
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
    [TOKEN_ID, ORG],
  );
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, $3, 'cajero', '0', 'open')`,
    [SESSION_ID, ORG, TOKEN_ID],
  );
}

/**
 * Seeds a pending handover: creates the transito account (via getOrCreatePendingAccount)
 * then inserts a handover movement. Returns the handover movement id.
 */
async function seedHandover(amount: number): Promise<string> {
  await seedPosSession();
  const pending = await getOrCreatePendingAccount(db, ORG, 'test');
  const row = await recordHandoverMovement(db, {
    organizationId: ORG,
    toAccountId: pending.id,
    amount,
    createdBy: 'test',
    cashSessionId: SESSION_ID,
  });
  return row.id;
}

// ── computeNetProfit helper (inline, no DB connection needed, just expenses) ──

async function netProfitExpenses(): Promise<number> {
  const { rows } = await pg.query<{ net: string }>(
    `SELECT COALESCE(SUM(amount::numeric), 0)::text AS net FROM expenses WHERE organization_id = $1`,
    [ORG],
  );
  return Number.parseFloat(rows[0]!.net);
}

// ── Slice 1: placeHandoverAsLoss ──────────────────────────────────────────────

describe('placeHandoverAsLoss', () => {
  it('creates a positive faltante expense row', async () => {
    const handoverMovementId = await seedHandover(500);

    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 100,
      note: 'billete que se cayó',
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const { rows } = await pg.query<{ amount: string; category: string; description: string }>(
      `SELECT amount, category, description FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(rows).toHaveLength(1);
    expect(Number.parseFloat(rows[0]!.amount)).toBeCloseTo(100, 2);
    expect(rows[0]!.category).toBe('faltante');
    expect(rows[0]!.description).toContain('billete que se cayó');
  });

  it('category is always faltante regardless of caller input', async () => {
    const handoverMovementId = await seedHandover(500);

    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 50,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const { rows } = await pg.query<{ category: string }>(
      `SELECT category FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(rows[0]!.category).toBe('faltante');
  });

  it('lowers net profit by the lost amount (expense SUM increases)', async () => {
    const handoverMovementId = await seedHandover(500);
    const before = await netProfitExpenses();

    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 200,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const after = await netProfitExpenses();

    expect(after - before).toBeCloseTo(200, 2);
  });

  it('drains the handover remaining', async () => {
    const handoverMovementId = await seedHandover(500);

    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 300,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const { rows } = await pg.query<{ remaining: string }>(
      `SELECT (h.amount - COALESCE(SUM(p.amount), 0))::text AS remaining
       FROM treasury_movements h
       LEFT JOIN treasury_movements p ON p.handover_movement_id = h.id
       WHERE h.id = $1
       GROUP BY h.amount`,
      [handoverMovementId],
    );

    expect(Number.parseFloat(rows[0]!.remaining)).toBeCloseTo(200, 2);
  });

  it('over-placement guard: rejects amount > remaining', async () => {
    const handoverMovementId = await seedHandover(100);

    await expect(
      placeHandoverAsLoss(db, {
        organizationId: ORG,
        handoverMovementId,
        amount: 200, // more than 100 remaining
        incurredOn: '2026-06-18',
        createdBy: 'owner',
      }),
    ).rejects.toThrow();

    // Nothing written
    const { rows } = await pg.query(
      `SELECT id FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(rows).toHaveLength(0);
  });

  it('defaults description to "Faltante de efectivo" when no note given', async () => {
    const handoverMovementId = await seedHandover(500);

    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 50,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const { rows } = await pg.query<{ description: string }>(
      `SELECT description FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(rows[0]!.description).toContain('Faltante de efectivo');
  });
});
