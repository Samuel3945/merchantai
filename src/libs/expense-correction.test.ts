/**
 * REQ-8: delete-as-correction for posted gastos.
 *
 * Spec: posted expenses rows are immutable. "Deleting" a gasto posts a
 * referenced reversing correction (negative-amount expenses row) and — for
 * treasury-sourced gastos — a compensating treasury_movements entrada to
 * restore the container balance.
 *
 * Strict TDD — RED phase: all tests fail until correctGastoExpense is implemented.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { correctGastoExpense } from '@/libs/expense-correction';

// ── Minimal PGLite DDL ───────────────────────────────────────────────────────

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'fiado_payment', 'reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'confirmed', 'not_arrived', 'mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable', 'loss', 'cashier_liability')`,
  `CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover')`,
];

const DDL = `
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
    transfer_reconciliation_id uuid,
    handover_movement_id uuid REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    created_by text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

// Fixed UUIDs
const ORG = 'org-correction';
const OTHER_ORG = 'org-other';
const ACC_VAULT = '00000000-0000-0000-0001-000000000001';
const EXP_TREASURY = '00000000-0000-0000-0002-000000000001';
const EXP_POS = '00000000-0000-0000-0002-000000000002';
const TREAS_MOV = '00000000-0000-0000-0003-000000000001';
const TOKEN_ID = '00000000-0000-0000-0004-000000000001';
const SESSION_ID = '00000000-0000-0000-0005-000000000001';
const CASH_MOV = '00000000-0000-0000-0006-000000000001';

type Executor = Parameters<typeof correctGastoExpense>[0];
let pg: PGlite;
let db: Executor;

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
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM payment_methods');
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedVault() {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name)
     VALUES ($1, $2, 'caja_fuerte', 'Bóveda')`,
    [ACC_VAULT, ORG],
  );
}

async function seedTreasuryGasto(id: string, amount: string) {
  await pg.query(
    `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
     VALUES ($1, $2, $3, 'servicios', '2026-06-01', 'owner')`,
    [id, ORG, amount],
  );
  await pg.query(
    `INSERT INTO treasury_movements (id, organization_id, from_account_id, amount, type, expense_id, created_by)
     VALUES ($1, $2, $3, $4, 'gasto', $5, 'owner')`,
    [TREAS_MOV, ORG, ACC_VAULT, amount, id],
  );
}

async function seedPosGasto(id: string, amount: string) {
  await pg.query(
    `INSERT INTO pos_tokens (id, organization_id, device_name) VALUES ($1, $2, 'Caja 1')`,
    [TOKEN_ID, ORG],
  );
  await pg.query(
    `INSERT INTO cash_sessions (id, organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, $3, 'cajero', '0', 'open')`,
    [SESSION_ID, ORG, TOKEN_ID],
  );
  await pg.query(
    `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
     VALUES ($1, $2, $3, 'otros', '2026-06-02', 'system')`,
    [id, ORG, amount],
  );
  await pg.query(
    `INSERT INTO cash_movements (id, session_id, organization_id, type, amount, reason, created_by, expense_id)
     VALUES ($1, $2, $3, 'expense', $4, 'supplies', 'cajero', $5)`,
    [CASH_MOV, SESSION_ID, ORG, amount, id],
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('correctGastoExpense — treasury-sourced gasto', () => {
  it('leaves the original expenses row untouched', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    const { rows: origRows } = await pg.query<{ id: string; amount: string }>(
      `SELECT id, amount FROM expenses WHERE id = $1`,
      [EXP_TREASURY],
    );

    expect(origRows).toHaveLength(1);
    expect(Number.parseFloat(origRows[0]!.amount)).toBeCloseTo(100, 2);
  });

  it('inserts a negative-amount reversing expenses row referencing the original', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ amount: string; description: string }>(
      `SELECT amount, description FROM expenses WHERE id != $1 AND organization_id = $2`,
      [EXP_TREASURY, ORG],
    );

    expect(rows).toHaveLength(1);
    expect(Number.parseFloat(rows[0]!.amount)).toBeCloseTo(-100, 2);
    expect(rows[0]!.description).toContain(EXP_TREASURY);
  });

  it('posts a compensating treasury_movements entrada to restore the container balance', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ type: string; to_account_id: string; amount: string }>(
      `SELECT type, to_account_id, amount FROM treasury_movements
       WHERE organization_id = $1 AND expense_id IS NULL AND id != $2`,
      [ORG, TREAS_MOV],
    );
    // One compensating entrada to restore vault
    const entrada = rows.find(r => r.type === 'entrada');

    expect(entrada).toBeDefined();
    expect(entrada!.to_account_id).toBe(ACC_VAULT);
    expect(Number.parseFloat(entrada!.amount)).toBeCloseTo(100, 2);
  });

  it('makes the P&L net delta zero after correction (original + reversal = 0)', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ net: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0)::text AS net
       FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number.parseFloat(rows[0]!.net)).toBeCloseTo(0, 2);
  });
});

describe('correctGastoExpense — POS-sourced gasto', () => {
  it('leaves the original expenses row untouched', async () => {
    await seedPosGasto(EXP_POS, '50.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_POS,
      correctedBy: 'owner',
    });

    const { rows: origRows } = await pg.query<{ id: string; amount: string }>(
      `SELECT id, amount FROM expenses WHERE id = $1`,
      [EXP_POS],
    );

    expect(origRows).toHaveLength(1);
    expect(Number.parseFloat(origRows[0]!.amount)).toBeCloseTo(50, 2);
  });

  it('inserts a negative-amount reversing expenses row referencing the original', async () => {
    await seedPosGasto(EXP_POS, '50.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_POS,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ amount: string; description: string }>(
      `SELECT amount, description FROM expenses WHERE id != $1 AND organization_id = $2`,
      [EXP_POS, ORG],
    );

    expect(rows).toHaveLength(1);
    expect(Number.parseFloat(rows[0]!.amount)).toBeCloseTo(-50, 2);
    expect(rows[0]!.description).toContain(EXP_POS);
  });

  it('does NOT post any new treasury_movements (cash drawer stays read-only)', async () => {
    await seedPosGasto(EXP_POS, '50.00');
    const { rows: before } = await pg.query(
      `SELECT id FROM treasury_movements WHERE organization_id = $1`,
      [ORG],
    );

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_POS,
      correctedBy: 'owner',
    });

    const { rows: after } = await pg.query(
      `SELECT id FROM treasury_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(after).toHaveLength(before.length); // no new treasury_movements
  });

  it('makes the P&L net delta zero after correction', async () => {
    await seedPosGasto(EXP_POS, '50.00');

    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_POS,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ net: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0)::text AS net
       FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number.parseFloat(rows[0]!.net)).toBeCloseTo(0, 2);
  });
});

describe('correctGastoExpense — guard rails', () => {
  it('throws when expense does not belong to the org (cross-org guard)', async () => {
    // Seed expense in OTHER_ORG, call with ORG — must be rejected
    await pg.query(
      `INSERT INTO expenses (id, organization_id, amount, category, incurred_on, created_by)
       VALUES ($1, $2, '200.00', 'arriendo', '2026-06-05', 'owner')`,
      [EXP_TREASURY, OTHER_ORG],
    );

    await expect(
      correctGastoExpense(db, {
        organizationId: ORG,
        expenseId: EXP_TREASURY,
        correctedBy: 'owner',
      }),
    ).rejects.toThrow();
  });

  it('throws when expense does not exist', async () => {
    const nonExistent = '99999999-9999-9999-9999-999999999999';

    await expect(
      correctGastoExpense(db, {
        organizationId: ORG,
        expenseId: nonExistent,
        correctedBy: 'owner',
      }),
    ).rejects.toThrow();
  });
});

// ── C1 remediation: server/DB-side idempotency ───────────────────────────────
describe('correctGastoExpense — idempotency (C1)', () => {
  it('sets reverses_expense_id on the reversal row (column is source of truth)', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    const { reversalExpenseId } = await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ reverses_expense_id: string }>(
      `SELECT reverses_expense_id FROM expenses WHERE id = $1`,
      [reversalExpenseId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.reverses_expense_id).toBe(EXP_TREASURY);
  });

  it('rejects a second correction of the same gasto (no phantom money)', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    // First correction succeeds.
    await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    // Second correction MUST be rejected.
    await expect(
      correctGastoExpense(db, {
        organizationId: ORG,
        expenseId: EXP_TREASURY,
        correctedBy: 'owner',
      }),
    ).rejects.toThrow();

    // P&L still nets to 0 (original 100 + one reversal -100), NOT -100.
    const { rows: pnl } = await pg.query<{ net: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0)::text AS net
       FROM expenses WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number.parseFloat(pnl[0]!.net)).toBeCloseTo(0, 2);

    // Exactly ONE compensating entrada exists (no +200 phantom in the container).
    const { rows: entradas } = await pg.query<{ amount: string }>(
      `SELECT amount FROM treasury_movements
       WHERE organization_id = $1 AND type = 'entrada' AND to_account_id = $2`,
      [ORG, ACC_VAULT],
    );

    expect(entradas).toHaveLength(1);
    expect(Number.parseFloat(entradas[0]!.amount)).toBeCloseTo(100, 2);
  });

  it('rejects correcting a row that is itself a reversal (cannot correct a correction)', async () => {
    await seedVault();
    await seedTreasuryGasto(EXP_TREASURY, '100.00');

    const { reversalExpenseId } = await correctGastoExpense(db, {
      organizationId: ORG,
      expenseId: EXP_TREASURY,
      correctedBy: 'owner',
    });

    await expect(
      correctGastoExpense(db, {
        organizationId: ORG,
        expenseId: reversalExpenseId,
        correctedBy: 'owner',
      }),
    ).rejects.toThrow();
  });
});
