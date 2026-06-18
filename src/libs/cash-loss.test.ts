/**
 * Strict TDD — cash-loss feature (Slice 1 + Slice 2).
 *
 * Slice 1: placeHandoverAsLoss
 *   - creates a positive 'faltante' expense
 *   - drains the handover remaining
 *   - lowers computeNetProfit by the lost amount
 *   - over-placement guard (cannot lose more than remaining)
 *
 * Slice 2: listRecoverableLosses + recoverLoss
 *   - listRecoverableLosses returns faltante expenses not yet reversed
 *   - recoverLoss → caja_fuerte: reverses expense (P&L restored) + cofre balance up
 *   - recoverLoss → banco: reverses expense + banco balance up
 *   - recoverLoss → pendiente: reverses expense + new handover appears in pending queue
 *   - double-recovery blocked (idempotency)
 *   - conservation: total treasury value conserved across loss→recovery
 */

import type {
  getTreasuryPosition,
} from '@/libs/treasury';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listRecoverableLosses, placeHandoverAsLoss, recoverLoss } from '@/libs/cash-loss';
import {
  countPendingHandovers,
  getOrCreatePendingAccount,
  listPendingHandovers,
  recordGastoOutflow,
  recordHandoverMovement,
} from '@/libs/treasury';

// ── PGLite DDL (mirrors treasury.test.ts exactly) ──────────────────────────

type Executor = Parameters<typeof getTreasuryPosition>[0];

let pg: PGlite;
let db: Executor;

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale', 'deposit', 'expense', 'salary', 'inventory_purchase', 'withdrawal', 'adjustment', 'advance', 'fiado_payment', 'reclassification')`,
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
    resolution_fiado_id uuid,
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
const VAULT_ID = '00000000-0000-0000-0000-000000000cc1';
const BANCO_ID = '00000000-0000-0000-0000-000000000dd1';

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

async function seedAccounts() {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, type, name, opening_balance)
     VALUES ($1, $2, 'caja_fuerte', 'Bóveda', '0'),
            ($3, $2, 'banco', 'Bancolombia', '0')`,
    [VAULT_ID, ORG, BANCO_ID],
  );
}

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

// ── Slice 2: listRecoverableLosses ────────────────────────────────────────────

describe('listRecoverableLosses', () => {
  it('returns faltante expenses that have not been reversed', async () => {
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 100,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const losses = await listRecoverableLosses(db, ORG);

    expect(losses).toHaveLength(1);
    expect(losses[0]!.amount).toBeCloseTo(100, 2);
  });

  it('excludes reversed losses from the list', async () => {
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 100,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'pendiente',
      correctedBy: 'owner',
    });

    const remaining = await listRecoverableLosses(db, ORG);

    expect(remaining).toHaveLength(0);
  });

  it('excludes non-faltante expenses', async () => {
    // Seed a handover so transito has balance, then record a tesoreria gasto
    // (non-faltante). It should NOT appear in recoverable losses.
    await seedHandover(200);
    const pending = await getOrCreatePendingAccount(db, ORG, 'owner');
    await recordGastoOutflow(db, {
      organizationId: ORG,
      fromAccountId: pending.id,
      amount: '100',
      category: 'tesoreria',
      description: 'otro gasto',
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const losses = await listRecoverableLosses(db, ORG);

    expect(losses).toHaveLength(0);
  });
});

// ── Slice 2: recoverLoss — caja_fuerte ────────────────────────────────────────

describe('recoverLoss → caja_fuerte', () => {
  it('reverses the expense row (P&L restored)', async () => {
    await seedAccounts();
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 150,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'caja_fuerte',
      accountId: VAULT_ID,
      correctedBy: 'owner',
    });

    // P&L net = original (150) + reversal (-150) = 0
    const net = await netProfitExpenses();

    expect(net).toBeCloseTo(0, 2);
  });

  it('deposits recovered amount into the cofre balance', async () => {
    await seedAccounts();
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 150,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'caja_fuerte',
      accountId: VAULT_ID,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ credits: string; debits: string }>(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE to_account_id = $1), 0)::text AS credits,
        COALESCE(SUM(amount) FILTER (WHERE from_account_id = $1), 0)::text AS debits
       FROM treasury_movements WHERE organization_id = $2`,
      [VAULT_ID, ORG],
    );
    const balance = Number.parseFloat(rows[0]!.credits) - Number.parseFloat(rows[0]!.debits);

    expect(balance).toBeCloseTo(150, 2);
  });
});

// ── Slice 2: recoverLoss — banco ──────────────────────────────────────────────

describe('recoverLoss → banco', () => {
  it('reverses the expense (P&L restored)', async () => {
    await seedAccounts();
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 80,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'banco',
      accountId: BANCO_ID,
      correctedBy: 'owner',
    });

    const net = await netProfitExpenses();

    expect(net).toBeCloseTo(0, 2);
  });

  it('credits the banco account balance', async () => {
    await seedAccounts();
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 80,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'banco',
      accountId: BANCO_ID,
      correctedBy: 'owner',
    });

    const { rows } = await pg.query<{ credits: string; debits: string }>(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE to_account_id = $1), 0)::text AS credits,
        COALESCE(SUM(amount) FILTER (WHERE from_account_id = $1), 0)::text AS debits
       FROM treasury_movements WHERE organization_id = $2`,
      [BANCO_ID, ORG],
    );
    const balance = Number.parseFloat(rows[0]!.credits) - Number.parseFloat(rows[0]!.debits);

    expect(balance).toBeCloseTo(80, 2);
  });
});

// ── Slice 2: recoverLoss — pendiente ─────────────────────────────────────────

describe('recoverLoss → pendiente', () => {
  it('reverses the expense (P&L restored)', async () => {
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 60,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'pendiente',
      correctedBy: 'owner',
    });

    const net = await netProfitExpenses();

    expect(net).toBeCloseTo(0, 2);
  });

  it('creates a new handover that appears in listPendingHandovers', async () => {
    const handoverMovementId = await seedHandover(500);
    // Fully drain the original handover so it doesn't appear in pending
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 500,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const before = await listPendingHandovers(db, ORG);

    expect(before).toHaveLength(0);

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'pendiente',
      correctedBy: 'owner',
    });

    const after = await listPendingHandovers(db, ORG);

    expect(after).toHaveLength(1);
    expect(after[0]!.remaining).toBeCloseTo(500, 2);
    expect(after[0]!.origin).toBe('Recuperación de faltante');
  });

  it('the recovered handover can be placed normally afterward', async () => {
    await seedAccounts();
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 500,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'pendiente',
      correctedBy: 'owner',
    });

    // The recovered handover should now be placeable
    const pending = await listPendingHandovers(db, ORG);

    expect(pending).toHaveLength(1);

    const recoveredHandoverId = pending[0]!.id;

    // Place it to the vault to confirm it can be consumed
    const pendingAccount = await getOrCreatePendingAccount(db, ORG, 'owner');
    const { recordContainerTransfer } = await import('@/libs/treasury');
    await recordContainerTransfer(db, {
      organizationId: ORG,
      fromAccountId: pendingAccount.id,
      toAccountId: VAULT_ID,
      amount: 500,
      createdBy: 'owner',
      handoverMovementId: recoveredHandoverId,
    });

    // Pending queue should be empty now
    const { count } = await countPendingHandovers(db, ORG);

    expect(count).toBe(0);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('recoverLoss — idempotency', () => {
  it('double-recovery is rejected (cannot recover the same loss twice)', async () => {
    const handoverMovementId = await seedHandover(500);
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 100,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    const [loss] = await listRecoverableLosses(db, ORG);
    // First recovery succeeds
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'pendiente',
      correctedBy: 'owner',
    });

    // Second recovery must fail
    await expect(
      recoverLoss(db, {
        organizationId: ORG,
        expenseId: loss!.id,
        destination: 'pendiente',
        correctedBy: 'owner',
      }),
    ).rejects.toThrow();

    // P&L net = original (100) + reversal (-100) = 0, NOT -100 (no double reversal)
    const net = await netProfitExpenses();

    expect(net).toBeCloseTo(0, 2);
  });
});

// ── Conservation ─────────────────────────────────────────────────────────────

describe('conservation: treasury value across loss → recovery', () => {
  it('total treasury sum is unchanged after loss then recovery to caja_fuerte', async () => {
    await seedAccounts();
    const handoverMovementId = await seedHandover(500);

    // After handover: transito has 500
    const pendingAccount = await getOrCreatePendingAccount(db, ORG, 'owner');

    // Place as loss (drains transito by 100, creates expense)
    await placeHandoverAsLoss(db, {
      organizationId: ORG,
      handoverMovementId,
      amount: 100,
      incurredOn: '2026-06-18',
      createdBy: 'owner',
    });

    // Remaining 400 in transito; expense created for 100
    // Treasury ledger value = 400 (transito remaining after loss drains it)
    const { rows: after_loss } = await pg.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE to_account_id = $1), 0)::text AS total
       FROM treasury_movements WHERE organization_id = $2`,
      [pendingAccount.id, ORG],
    );
    // The handover credited 500 to transito; the loss debit is gasto (from_account = transito)
    const { rows: loss_debits } = await pg.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE from_account_id = $1), 0)::text AS total
       FROM treasury_movements WHERE organization_id = $2`,
      [pendingAccount.id, ORG],
    );
    const transitoAfterLoss = Number.parseFloat(after_loss[0]!.total) - Number.parseFloat(loss_debits[0]!.total);

    expect(transitoAfterLoss).toBeCloseTo(400, 2);

    // Recover to vault
    const [loss] = await listRecoverableLosses(db, ORG);
    await recoverLoss(db, {
      organizationId: ORG,
      expenseId: loss!.id,
      destination: 'caja_fuerte',
      accountId: VAULT_ID,
      correctedBy: 'owner',
    });

    // After recovery: transito = 500, vault = 100, net total conserved
    const { rows: final_credits } = await pg.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE to_account_id = $1), 0)::text AS total
       FROM treasury_movements WHERE organization_id = $2`,
      [pendingAccount.id, ORG],
    );
    const { rows: final_debits } = await pg.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE from_account_id = $1), 0)::text AS total
       FROM treasury_movements WHERE organization_id = $2`,
      [pendingAccount.id, ORG],
    );
    const transitoFinal = Number.parseFloat(final_credits[0]!.total) - Number.parseFloat(final_debits[0]!.total);
    // transito: handover(500) + recovery entrada(100) - loss gasto(100) - recovery transfer to vault(100) = 400
    // vault: +100 from recovery transfer
    // total value = 400 + 100 = 500 = original handover amount

    const { rows: vault_balance } = await pg.query<{ credits: string; debits: string }>(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE to_account_id = $1), 0)::text AS credits,
        COALESCE(SUM(amount) FILTER (WHERE from_account_id = $1), 0)::text AS debits
       FROM treasury_movements WHERE organization_id = $2`,
      [VAULT_ID, ORG],
    );
    const vaultBalance = Number.parseFloat(vault_balance[0]!.credits) - Number.parseFloat(vault_balance[0]!.debits);

    const totalValue = transitoFinal + vaultBalance;

    expect(totalValue).toBeCloseTo(500, 2);
  });
});
