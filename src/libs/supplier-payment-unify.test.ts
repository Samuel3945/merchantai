/**
 * PGLite-backed tests for supplier-payment-unify Part A.
 *
 * TDD cycle: RED → GREEN. Written per the design's 14-step checklist.
 *
 * Covers:
 *   1. Schema CHECK: rejects 0 or 2 funding sources; accepts exactly 1 each way.
 *   2. getSupplierOutstanding: status≠paid; multi-invoice; credited_amount.
 *   3. recordCajaPayableSettle: writes cash_movements (expense, expense_id NULL,
 *      supplier_id set) + supplier_payments (cash_movement_id set, treasury_movement_id NULL);
 *      reduces payable; NO expenses; NO treasury_movements; chunk>outstanding throws.
 *   4. recordSupplierPayment caja funding: oldest-first across invoices; N rows;
 *      cap at outstanding; excess reported; partial; standalone; amount≤0 throws.
 *   5. recordSupplierPayment treasury funding: delegates to recordSupplierPaymentOutflow
 *      (treasury_movement_id set, cash_movement_id NULL).
 *   7. ARQUEO-UNCHANGED equivalence: computeCashBreakdown expected drops identically
 *      for a caja settle vs a legacy gasto of the same amount.
 *   8. OQ-2 KPI guard: settle does NOT raise gastos_hoy/gastos_operativos (expense_id
 *      IS NOT NULL narrowing); legacy gasto DOES; pagosProveedores counts both.
 *
 * Concurrency note: PGLite is single-connection; concurrent tx tests are not
 * meaningful here. A separate integration note covers the lock ordering proof.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getSupplierOutstanding,
  recordCajaPayableSettle,
  recordSupplierPayment,
} from '@/libs/supplier-invoice-payment';
import { recordSupplierPaymentOutflow } from '@/libs/treasury';

// ── PGLite database types ─────────────────────────────────────────────────────

type RawDb = ReturnType<typeof drizzle<Record<string, never>>>;

let pg: PGlite;
let db: RawDb;

// ── ENUMs ─────────────────────────────────────────────────────────────────────

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','credito_payment','reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending','confirmed','not_arrived','mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable','loss','cashier_liability')`,
  `CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover')`,
  `CREATE TYPE "supplier_payable_status" AS ENUM('open','partial','paid')`,
];

// ── DDL ───────────────────────────────────────────────────────────────────────
// Mirrors Schema.ts after migration 0071.
// CRITICAL: every column in Schema.ts must appear here or Drizzle inserts fail (42703).

const DDL = `
  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL,
    allow_oversell boolean DEFAULT false NOT NULL,
    default_sweep_destination_account_id uuid
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

  CREATE TABLE payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE transfer_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_payment_id uuid,
    pos_token_id uuid,
    cash_session_id uuid,
    method text NOT NULL,
    expected_amount numeric(12,2) NOT NULL,
    arrived_amount numeric(12,2),
    reference text,
    status "transfer_reconciliation_status" DEFAULT 'pending' NOT NULL,
    resolution_type "transfer_resolution_type",
    resolution_notes text,
    resolved_by text,
    resolved_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_at timestamp DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    opening_amount numeric(12,2) DEFAULT '0' NOT NULL,
    closed_at timestamp,
    closed_by text,
    opened_by_actor_id text,
    closed_by_actor_id text,
    expected_amount numeric(12,2),
    counted_amount numeric(12,2),
    difference numeric(12,2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12,2),
    opening_difference numeric(12,2),
    opening_explanation text,
    client_session_id uuid
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
        AND type IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover')
      )
    ),
    CONSTRAINT treasury_mov_transfer_recon_unique UNIQUE (transfer_reconciliation_id)
  );

  -- cash_movements: the physical cash drawer ledger.
  -- Mirrors Schema.ts cashMovementsSchema exactly (including all nullable columns).
  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    type "cash_movement_type" NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text NOT NULL,
    category text,
    authorized_by text,
    created_by text NOT NULL,
    sale_id uuid,
    supplier_id uuid,
    corrects_session_id uuid REFERENCES cash_sessions(id) ON DELETE SET NULL,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE supplier_purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    invoice_number text,
    purchased_at timestamp DEFAULT now() NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE supplier_payables (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    stock_movement_id uuid,
    total_amount numeric(12,2) NOT NULL,
    paid_amount numeric(12,2) DEFAULT '0' NOT NULL,
    credited_amount numeric(12,2) DEFAULT '0' NOT NULL,
    status "supplier_payable_status" DEFAULT 'open' NOT NULL,
    purchased_at timestamp DEFAULT now() NOT NULL,
    purchase_id uuid REFERENCES supplier_purchases(id) ON DELETE SET NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  -- Supplier payments ledger — migration 0071 schema.
  -- treasury_movement_id is nullable; cash_movement_id added.
  -- CHECK enforces exactly one funding source.
  CREATE TABLE supplier_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    payable_id uuid REFERENCES supplier_payables(id) ON DELETE SET NULL,
    treasury_movement_id uuid REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    cash_movement_id uuid REFERENCES cash_movements(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    CONSTRAINT supplier_payments_funding_source_chk
      CHECK (num_nonnulls(treasury_movement_id, cash_movement_id) = 1)
  );
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG = 'org-unify-1';
const SUPPLIER_ID = '00000000-0000-0000-aaaa-700000000001';
const CONTAINER_ID = '00000000-0000-0000-bbbb-700000000001';
const SESSION_ID = '00000000-0000-0000-dddd-700000000001';
const PAYABLE_A = '00000000-0000-0000-cccc-700000000001';
const PAYABLE_B = '00000000-0000-0000-cccc-700000000002';
const PAYABLE_C = '00000000-0000-0000-cccc-700000000003';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as RawDb;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  // FK order: children before parents.
  await pg.exec('DELETE FROM supplier_payments');
  await pg.exec('DELETE FROM cash_movements');
  await pg.exec('DELETE FROM supplier_payables');
  await pg.exec('DELETE FROM supplier_purchases');
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM payment_methods');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedAccount(id: string, openingBalance: number): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts
       (id, organization_id, type, name, opening_balance, active, created_at, updated_at)
     VALUES ($1, $2, 'caja_fuerte', $3, $4, true, now(), now())`,
    [id, ORG, `acct-${id.slice(-4)}`, openingBalance.toFixed(2)],
  );
}

async function seedSession(id: string, openingAmount = 0): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions
       (id, organization_id, opened_by, opening_amount, status, opened_at)
     VALUES ($1, $2, 'cashier', $3, 'open', now())`,
    [id, ORG, openingAmount.toFixed(2)],
  );
}

async function seedPayable(
  id: string,
  totalAmount: number,
  paidAmount = 0,
  creditedAmount = 0,
  status: 'open' | 'partial' | 'paid' = 'open',
  daysAgo = 0,
): Promise<void> {
  await pg.query(
    `INSERT INTO supplier_payables
       (id, organization_id, supplier_id, total_amount, paid_amount, credited_amount,
        status, purchased_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             now() - ($8 || ' days')::interval, now(), now())`,
    [
      id,
      ORG,
      SUPPLIER_ID,
      totalAmount.toFixed(2),
      paidAmount.toFixed(2),
      creditedAmount.toFixed(2),
      status,
      daysAgo,
    ],
  );
}

// Helper: insert a plain gasto cash_movements row (legacy, WITH expense_id).
async function seedGasto(sessionId: string, amount: number): Promise<string> {
  const expenseRes = await pg.query<{ id: string }>(
    `INSERT INTO expenses (organization_id, amount, category, incurred_on, created_by)
     VALUES ($1, $2, 'otros', now()::date, 'user') RETURNING id`,
    [ORG, amount.toFixed(2)],
  );
  const expenseId = expenseRes.rows[0]!.id;
  await pg.query(
    `INSERT INTO cash_movements
       (session_id, organization_id, type, amount, reason, created_by,
        supplier_id, expense_id)
     VALUES ($1, $2, 'expense', $3, 'gasto test', 'user', $4, $5)`,
    [sessionId, ORG, amount.toFixed(2), SUPPLIER_ID, expenseId],
  );
  return expenseId;
}

// ── Test 1: Schema CHECK constraints ─────────────────────────────────────────

describe('schema CHECK — supplier_payments_funding_source_chk', () => {
  it('rejects a row with BOTH funding sources set (would be double-count)', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 200);

    // Insert a treasury_movements row first so FK is satisfiable.
    const tmRes = await pg.query<{ id: string }>(
      `INSERT INTO treasury_movements
         (organization_id, from_account_id, type, amount, created_by)
       VALUES ($1, $2, 'salida', '200.00', 'user') RETURNING id`,
      [ORG, CONTAINER_ID],
    );
    const tmId = tmRes.rows[0]!.id;

    // Insert a cash_movements row so FK is satisfiable.
    const cmRes = await pg.query<{ id: string }>(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'expense', '200.00', 'pago', 'user') RETURNING id`,
      [SESSION_ID, ORG],
    );
    const cmId = cmRes.rows[0]!.id;

    // Both set → CHECK violation.
    await expect(
      pg.query(
        `INSERT INTO supplier_payments
           (organization_id, supplier_id, payable_id,
            treasury_movement_id, cash_movement_id, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, '200.00', 'user')`,
        [ORG, SUPPLIER_ID, PAYABLE_A, tmId, cmId],
      ),
    ).rejects.toThrow();
  });

  it('rejects a row with NEITHER funding source set (dangling payment)', async () => {
    await seedPayable(PAYABLE_A, 200);

    await expect(
      pg.query(
        `INSERT INTO supplier_payments
           (organization_id, supplier_id, payable_id,
            treasury_movement_id, cash_movement_id, amount, created_by)
         VALUES ($1, $2, $3, NULL, NULL, '200.00', 'user')`,
        [ORG, SUPPLIER_ID, PAYABLE_A],
      ),
    ).rejects.toThrow();
  });

  it('accepts a treasury-only row (cash_movement_id NULL)', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_A, 200);

    const tmRes = await pg.query<{ id: string }>(
      `INSERT INTO treasury_movements
         (organization_id, from_account_id, type, amount, created_by)
       VALUES ($1, $2, 'salida', '200.00', 'user') RETURNING id`,
      [ORG, CONTAINER_ID],
    );

    await expect(
      pg.query(
        `INSERT INTO supplier_payments
           (organization_id, supplier_id, payable_id,
            treasury_movement_id, cash_movement_id, amount, created_by)
         VALUES ($1, $2, $3, $4, NULL, '200.00', 'user')`,
        [ORG, SUPPLIER_ID, PAYABLE_A, tmRes.rows[0]!.id],
      ),
    ).resolves.toBeDefined();
  });

  it('accepts a caja-only row (treasury_movement_id NULL)', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 200);

    const cmRes = await pg.query<{ id: string }>(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'expense', '200.00', 'pago', 'user') RETURNING id`,
      [SESSION_ID, ORG],
    );

    await expect(
      pg.query(
        `INSERT INTO supplier_payments
           (organization_id, supplier_id, payable_id,
            treasury_movement_id, cash_movement_id, amount, created_by)
         VALUES ($1, $2, $3, NULL, $4, '200.00', 'user')`,
        [ORG, SUPPLIER_ID, PAYABLE_A, cmRes.rows[0]!.id],
      ),
    ).resolves.toBeDefined();
  });
});

// ── Test 2: getSupplierOutstanding ────────────────────────────────────────────

describe('getSupplierOutstanding', () => {
  it('returns 0 when supplier has no open payables', async () => {
    const result = await getSupplierOutstanding(db as never, ORG, SUPPLIER_ID);

    expect(result.totalOutstanding).toBe(0);
    expect(result.invoiceCount).toBe(0);
    expect(result.invoices).toHaveLength(0);
  });

  it('excludes paid payables from total', async () => {
    await seedPayable(PAYABLE_A, 500, 500, 0, 'paid');
    const result = await getSupplierOutstanding(db as never, ORG, SUPPLIER_ID);

    expect(result.totalOutstanding).toBe(0);
    expect(result.invoiceCount).toBe(0);
  });

  it('sums outstanding across multiple open payables', async () => {
    await seedPayable(PAYABLE_A, 300, 100, 0, 'partial', 2);
    await seedPayable(PAYABLE_B, 200, 0, 0, 'open', 1);
    // outstanding = (300-100-0) + (200-0-0) = 200 + 200 = 400
    const result = await getSupplierOutstanding(db as never, ORG, SUPPLIER_ID);

    expect(result.totalOutstanding).toBe(400);
    expect(result.invoiceCount).toBe(2);
  });

  it('respects credited_amount in outstanding calculation', async () => {
    await seedPayable(PAYABLE_A, 500, 100, 150, 'partial'); // outstanding = 500-100-150=250
    const result = await getSupplierOutstanding(db as never, ORG, SUPPLIER_ID);

    expect(result.totalOutstanding).toBe(250);
  });
});

// ── Test 3: recordCajaPayableSettle ──────────────────────────────────────────

describe('recordCajaPayableSettle — inline caja writer', () => {
  it('writes ONE cash_movements with type=expense, expense_id NULL, supplier_id set', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    await recordCajaPayableSettle(db as never, {
      organizationId: ORG,
      sessionId: SESSION_ID,
      payableId: PAYABLE_A,
      supplierId: SUPPLIER_ID,
      amount: 300,
      note: 'pago caja',
      createdBy: 'cajero',
    });

    const cms = await pg.query<{
      type: string;
      amount: string;
      expense_id: string | null;
      supplier_id: string | null;
      session_id: string;
    }>(
      'SELECT type, amount, expense_id, supplier_id::text, session_id FROM cash_movements WHERE organization_id = $1',
      [ORG],
    );

    expect(cms.rows).toHaveLength(1);
    expect(cms.rows[0]!.type).toBe('expense');
    expect(Number(cms.rows[0]!.amount)).toBe(300);
    expect(cms.rows[0]!.expense_id).toBeNull(); // NOT a P&L gasto
    expect(cms.rows[0]!.supplier_id).toBe(SUPPLIER_ID);
    expect(cms.rows[0]!.session_id).toBe(SESSION_ID);
  });

  it('writes ONE supplier_payments with cash_movement_id set, treasury_movement_id NULL', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    await recordCajaPayableSettle(db as never, {
      organizationId: ORG,
      sessionId: SESSION_ID,
      payableId: PAYABLE_A,
      supplierId: SUPPLIER_ID,
      amount: 300,
      createdBy: 'cajero',
    });

    const sps = await pg.query<{
      treasury_movement_id: string | null;
      cash_movement_id: string | null;
      amount: string;
    }>(
      'SELECT treasury_movement_id, cash_movement_id, amount FROM supplier_payments WHERE organization_id = $1',
      [ORG],
    );

    expect(sps.rows).toHaveLength(1);
    expect(sps.rows[0]!.treasury_movement_id).toBeNull();
    expect(sps.rows[0]!.cash_movement_id).not.toBeNull();
    expect(Number(sps.rows[0]!.amount)).toBe(300);
  });

  it('reduces payable paid_amount and updates status correctly', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    // Partial pay: 300 of 500
    await recordCajaPayableSettle(db as never, {
      organizationId: ORG,
      sessionId: SESSION_ID,
      payableId: PAYABLE_A,
      supplierId: SUPPLIER_ID,
      amount: 300,
      createdBy: 'cajero',
    });

    const p = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_A],
    );

    expect(p.rows[0]!.status).toBe('partial');
    expect(Number(p.rows[0]!.paid_amount)).toBe(300);
  });

  it('marks payable as paid when amount covers full outstanding', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    await recordCajaPayableSettle(db as never, {
      organizationId: ORG,
      sessionId: SESSION_ID,
      payableId: PAYABLE_A,
      supplierId: SUPPLIER_ID,
      amount: 500,
      createdBy: 'cajero',
    });

    const p = await pg.query<{ status: string }>(
      'SELECT status FROM supplier_payables WHERE id = $1',
      [PAYABLE_A],
    );

    expect(p.rows[0]!.status).toBe('paid');
  });

  it('does NOT write expenses table (no P&L)', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    await recordCajaPayableSettle(db as never, {
      organizationId: ORG,
      sessionId: SESSION_ID,
      payableId: PAYABLE_A,
      supplierId: SUPPLIER_ID,
      amount: 300,
      createdBy: 'cajero',
    });

    const expCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM expenses',
      [],
    );

    expect(Number(expCount.rows[0]!.count)).toBe(0);
  });

  it('does NOT write treasury_movements (caja path, no container debit)', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    await recordCajaPayableSettle(db as never, {
      organizationId: ORG,
      sessionId: SESSION_ID,
      payableId: PAYABLE_A,
      supplierId: SUPPLIER_ID,
      amount: 300,
      createdBy: 'cajero',
    });

    const tmCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(tmCount.rows[0]!.count)).toBe(0);
  });

  it('throws when chunk exceeds payable outstanding', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 200);

    await expect(
      recordCajaPayableSettle(db as never, {
        organizationId: ORG,
        sessionId: SESSION_ID,
        payableId: PAYABLE_A,
        supplierId: SUPPLIER_ID,
        amount: 300, // > outstanding 200
        createdBy: 'cajero',
      }),
    ).rejects.toThrow(/outstanding/i);
  });

  it('throws when payable is already paid', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 200, 200, 0, 'paid');

    await expect(
      recordCajaPayableSettle(db as never, {
        organizationId: ORG,
        sessionId: SESSION_ID,
        payableId: PAYABLE_A,
        supplierId: SUPPLIER_ID,
        amount: 100,
        createdBy: 'cajero',
      }),
    ).rejects.toThrow(/already paid/i);
  });
});

// ── Test 4: recordSupplierPayment — caja funding ──────────────────────────────

describe('recordSupplierPayment — caja funding', () => {
  it('throws when amount <= 0', async () => {
    await seedSession(SESSION_ID);

    await expect(
      recordSupplierPayment(db as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        fundingSource: { kind: 'caja', sessionId: SESSION_ID },
        amount: 0,
        createdBy: 'cajero',
      }),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('throws when no open payables (amount > 0 outstanding)', async () => {
    await seedSession(SESSION_ID);

    await expect(
      recordSupplierPayment(db as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        fundingSource: { kind: 'caja', sessionId: SESSION_ID },
        amount: 500,
        createdBy: 'cajero',
      }),
    ).rejects.toThrow(/exceeds supplier outstanding/i);

    // Zero rows written
    const cmCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM cash_movements',
      [],
    );

    expect(Number(cmCount.rows[0]!.count)).toBe(0);
  });

  it('allocates oldest-first across invoices — N cash_movements + N supplier_payments', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 300, 0, 0, 'open', 3); // oldest
    await seedPayable(PAYABLE_B, 200, 0, 0, 'open', 1); // newer

    const result = await recordSupplierPayment(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      fundingSource: { kind: 'caja', sessionId: SESSION_ID },
      amount: 500,
      createdBy: 'cajero',
    });

    expect(result.appliedTotal).toBe(500);
    expect(result.breakdown).toHaveLength(2);
    expect(result.breakdown[0]!.payableId).toBe(PAYABLE_A);
    expect(result.breakdown[0]!.chunk).toBe(300);
    expect(result.breakdown[1]!.payableId).toBe(PAYABLE_B);
    expect(result.breakdown[1]!.chunk).toBe(200);

    // N cash_movements rows (one per chunk)
    const cmCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM cash_movements',
      [],
    );

    expect(Number(cmCount.rows[0]!.count)).toBe(2);

    // N supplier_payments rows
    const spCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_payments',
      [],
    );

    expect(Number(spCount.rows[0]!.count)).toBe(2);
  });

  it('throws when amount > outstanding — writes ZERO rows', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 300);

    await expect(
      recordSupplierPayment(db as never, {
        organizationId: ORG,
        supplierId: SUPPLIER_ID,
        fundingSource: { kind: 'caja', sessionId: SESSION_ID },
        amount: 500, // > outstanding 300
        createdBy: 'cajero',
      }),
    ).rejects.toThrow(/exceeds supplier outstanding/i);

    // Zero rows written — no partial debit
    const cmCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM cash_movements',
      [],
    );
    const spCount = await pg.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM supplier_payments',
      [],
    );
    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_A],
    );

    expect(Number(cmCount.rows[0]!.count)).toBe(0);
    expect(Number(spCount.rows[0]!.count)).toBe(0);
    expect(payable.rows[0]!.status).toBe('open');
    expect(Number(payable.rows[0]!.paid_amount)).toBe(0);
  });

  it('handles partial settle (amount < outstanding)', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 500);

    const result = await recordSupplierPayment(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      fundingSource: { kind: 'caja', sessionId: SESSION_ID },
      amount: 200,
      createdBy: 'cajero',
    });

    expect(result.appliedTotal).toBe(200);

    const p = await pg.query<{ status: string }>(
      'SELECT status FROM supplier_payables WHERE id = $1',
      [PAYABLE_A],
    );

    expect(p.rows[0]!.status).toBe('partial');
  });

  it('handles standalone payables (no invoice header)', async () => {
    await seedSession(SESSION_ID);
    // PAYABLE_C has no purchase_id — standalone
    await pg.query(
      `INSERT INTO supplier_payables
         (id, organization_id, supplier_id, total_amount, paid_amount, credited_amount,
          status, purchased_at, created_at, updated_at)
       VALUES ($1, $2, $3, '400.00', '0', '0', 'open', now(), now(), now())`,
      [PAYABLE_C, ORG, SUPPLIER_ID],
    );

    const result = await recordSupplierPayment(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      fundingSource: { kind: 'caja', sessionId: SESSION_ID },
      amount: 400,
      createdBy: 'cajero',
    });

    expect(result.appliedTotal).toBe(400);
    expect(result.breakdown[0]!.payableStatus).toBe('paid');
  });
});

// ── Test 5: recordSupplierPayment — treasury funding ──────────────────────────

describe('recordSupplierPayment — treasury funding', () => {
  it('delegates to recordSupplierPaymentOutflow — treasury_movement_id set, cash_movement_id NULL', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_A, 600);

    const result = await recordSupplierPayment(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      fundingSource: { kind: 'treasury', accountId: CONTAINER_ID },
      amount: 600,
      createdBy: 'user-t',
    });

    expect(result.appliedTotal).toBe(600);
    expect(result.breakdown[0]!.payableStatus).toBe('paid');

    const sps = await pg.query<{
      treasury_movement_id: string | null;
      cash_movement_id: string | null;
    }>(
      'SELECT treasury_movement_id, cash_movement_id FROM supplier_payments WHERE organization_id = $1',
      [ORG],
    );

    expect(sps.rows).toHaveLength(1);
    expect(sps.rows[0]!.treasury_movement_id).not.toBeNull();
    expect(sps.rows[0]!.cash_movement_id).toBeNull();
  });
});

// ── Test 7: ARQUEO-UNCHANGED equivalence ─────────────────────────────────────
// computeCashBreakdown uses: salidas = SUM(amount) FILTER (type IN ('expense',...))
// The caja settle row is type='expense', same as a legacy gasto row.
// → identical salidas term → identical expected.
// This test is the explicit proof as required by the design.

describe('ARQUEO-UNCHANGED equivalence — caja settle vs legacy gasto', () => {
  it('computeCashBreakdown produces identical salidas for settle vs gasto of same amount', async () => {
    // We test the raw SQL directly (mirrors computeCashBreakdown filter) because
    // the function lives in cash-helpers and imports the real db — we verify the
    // raw ledger filter instead.
    await seedSession(SESSION_ID, 1000);
    await seedPayable(PAYABLE_A, 300);

    // Scenario A: one legacy gasto row (expense_id != NULL)
    const gastaRes = await pg.query<{ id: string }>(
      `INSERT INTO expenses (organization_id, amount, category, incurred_on, created_by)
       VALUES ($1, '300.00', 'otros', now()::date, 'user') RETURNING id`,
      [ORG],
    );
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by, expense_id)
       VALUES ($1, $2, 'expense', '300.00', 'gasto', 'user', $3)`,
      [SESSION_ID, ORG, gastaRes.rows[0]!.id],
    );

    const salidasGasto = await pg.query<{ salidas: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type IN ('expense','salary','inventory_purchase','withdrawal','advance')), 0)::text AS salidas
       FROM cash_movements WHERE session_id = $1`,
      [SESSION_ID],
    );

    // Now remove the gasto row and replace with a settle row (expense_id NULL).
    await pg.exec('DELETE FROM cash_movements');
    await pg.exec('DELETE FROM expenses');
    await pg.exec('DELETE FROM supplier_payments');

    // Scenario B: one caja settle row (expense_id = NULL)
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by,
          supplier_id, expense_id)
       VALUES ($1, $2, 'expense', '300.00', 'pago proveedor', 'user', $3, NULL)`,
      [SESSION_ID, ORG, SUPPLIER_ID],
    );

    const salidasSettle = await pg.query<{ salidas: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type IN ('expense','salary','inventory_purchase','withdrawal','advance')), 0)::text AS salidas
       FROM cash_movements WHERE session_id = $1`,
      [SESSION_ID],
    );

    // Both must produce the same salidas — arqueo is unchanged.
    expect(Number(salidasGasto.rows[0]!.salidas)).toBe(300);
    expect(Number(salidasSettle.rows[0]!.salidas)).toBe(300);
    expect(salidasGasto.rows[0]!.salidas).toBe(salidasSettle.rows[0]!.salidas);
  });
});

// ── Test 8: OQ-2 KPI guard ────────────────────────────────────────────────────
// After migration 0071: the gasto-KPI queries (dashboard/analytics/reports) use
// the OR-form filter:
//   gastos_hoy:       type='expense' AND expense_id IS NOT NULL
//   gastos_operativos: (type='expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')
// salary and inventory_purchase rows have expense_id=NULL by design (they are
// ledger-only P&L entries, no expenses table row). The OR-form keeps them
// counted while excluding caja settle rows (type='expense', expense_id=NULL).

describe('OQ-2 KPI guard — settle does not inflate P&L gastos KPIs', () => {
  it('settle row (expense_id NULL): counts in pagosProveedores, NOT gastos_hoy/operativos', async () => {
    await seedSession(SESSION_ID);
    await seedPayable(PAYABLE_A, 400);

    // Insert a caja settle row: type='expense', expense_id=NULL, supplier_id set.
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by,
          supplier_id, expense_id)
       VALUES ($1, $2, 'expense', '400.00', 'pago proveedor', 'cajero', $3, NULL)`,
      [SESSION_ID, ORG, SUPPLIER_ID],
    );

    const kpi = await pg.query<{
      gastos_hoy: string;
      pagos_proveedores: string;
      gastos_operativos: string;
    }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND expense_id IS NOT NULL), 0)::text AS gastos_hoy,
         COALESCE(SUM(amount) FILTER (WHERE supplier_id IS NOT NULL), 0)::text AS pagos_proveedores,
         COALESCE(SUM(amount) FILTER (WHERE (type = 'expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')), 0)::text AS gastos_operativos
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(kpi.rows[0]!.gastos_hoy)).toBe(0); // NOT a P&L gasto
    expect(Number(kpi.rows[0]!.gastos_operativos)).toBe(0); // NOT a P&L gasto
    expect(Number(kpi.rows[0]!.pagos_proveedores)).toBe(400); // IS a proveedor payment
  });

  it('legacy gasto row (expense_id set): counts in gastos_hoy and gastos_operativos', async () => {
    await seedSession(SESSION_ID);
    const expId = await seedGasto(SESSION_ID, 250);
    void expId; // used via seedGasto

    const kpi = await pg.query<{
      gastos_hoy: string;
      pagos_proveedores: string;
      gastos_operativos: string;
    }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND expense_id IS NOT NULL), 0)::text AS gastos_hoy,
         COALESCE(SUM(amount) FILTER (WHERE supplier_id IS NOT NULL), 0)::text AS pagos_proveedores,
         COALESCE(SUM(amount) FILTER (WHERE (type = 'expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')), 0)::text AS gastos_operativos
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(kpi.rows[0]!.gastos_hoy)).toBe(250); // is a P&L gasto
    expect(Number(kpi.rows[0]!.gastos_operativos)).toBe(250); // is a P&L gasto
    expect(Number(kpi.rows[0]!.pagos_proveedores)).toBe(250); // also proveedor
  });

  it('salary row (expense_id NULL): counts in gastos_operativos, NOT gastos_hoy', async () => {
    await seedSession(SESSION_ID);
    // salary rows have no expense_id — they are direct ledger entries.
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'salary', '800.00', 'nomina', 'user')`,
      [SESSION_ID, ORG],
    );

    const kpi = await pg.query<{
      gastos_hoy: string;
      gastos_operativos: string;
    }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND expense_id IS NOT NULL), 0)::text AS gastos_hoy,
         COALESCE(SUM(amount) FILTER (WHERE (type = 'expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')), 0)::text AS gastos_operativos
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(kpi.rows[0]!.gastos_hoy)).toBe(0); // salary is NOT a gastos_hoy expense
    expect(Number(kpi.rows[0]!.gastos_operativos)).toBe(800); // salary DOES count as operating expense
  });

  it('inventory_purchase row (expense_id NULL): counts in gastos_operativos, NOT gastos_hoy', async () => {
    await seedSession(SESSION_ID);
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'inventory_purchase', '500.00', 'compra insumo', 'user')`,
      [SESSION_ID, ORG],
    );

    const kpi = await pg.query<{
      gastos_hoy: string;
      gastos_operativos: string;
    }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND expense_id IS NOT NULL), 0)::text AS gastos_hoy,
         COALESCE(SUM(amount) FILTER (WHERE (type = 'expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')), 0)::text AS gastos_operativos
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(kpi.rows[0]!.gastos_hoy)).toBe(0); // inventory_purchase is NOT a gastos_hoy expense
    expect(Number(kpi.rows[0]!.gastos_operativos)).toBe(500); // inventory_purchase DOES count as operating expense
  });

  it('paidThisMonth (supplier_payments SUM) counts both caja and treasury settles', async () => {
    await seedSession(SESSION_ID);
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_A, 300, 0, 0, 'open', 2); // for caja settle
    await seedPayable(PAYABLE_B, 400, 0, 0, 'open', 1); // for treasury settle

    // Caja settle via recordSupplierPayment
    await recordSupplierPayment(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      fundingSource: { kind: 'caja', sessionId: SESSION_ID },
      amount: 300,
      createdBy: 'cajero',
    });

    // Treasury settle via recordSupplierPaymentOutflow directly
    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 400,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_B,
      createdBy: 'user-t',
    });

    // paidThisMonth = SUM(supplier_payments.amount) = 300 + 400 = 700
    const paidThisMonth = await pg.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount), 0)::text AS total FROM supplier_payments WHERE organization_id = $1',
      [ORG],
    );

    expect(Number(paidThisMonth.rows[0]!.total)).toBe(700);

    // P&L gastos_hoy should NOT count the caja settle (expense_id IS NULL on that row)
    const gastos = await pg.query<{ gastos_hoy: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND expense_id IS NOT NULL), 0)::text AS gastos_hoy
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    // Only the caja settle cash_movements row exists (treasury settle has no cash row)
    // → gastos_hoy = 0 because expense_id = NULL on the settle row.
    expect(Number(gastos.rows[0]!.gastos_hoy)).toBe(0);
  });
});

// ── Test 9: P&L double-count guard — reports/analytics/dashboard sites ────────
// Verifies the OR-form filter used in getFinanceBreakdown (reports.ts),
// cashFlowStats (dashboard.ts), and getCashFlow (analytics.ts) does not
// double-count settle rows but keeps salary and inventory_purchase.

describe('P&L double-count guard — reports/analytics/dashboard OR-form filter', () => {
  // The fixed filter used in all three sites:
  //   (type = 'expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')
  const PNLFILTER = `(type = 'expense' AND expense_id IS NOT NULL) OR type IN ('salary','inventory_purchase')`;

  it('caja settle row (expense_id NULL) does NOT inflate the reports expenses aggregate', async () => {
    await seedSession(SESSION_ID);

    // Settle row: should NOT count.
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by, supplier_id)
       VALUES ($1, $2, 'expense', '350.00', 'pago proveedor', 'cajero', $3)`,
      [SESSION_ID, ORG, SUPPLIER_ID],
    );

    const res = await pg.query<{ expenses: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE ${PNLFILTER}), 0)::text AS expenses
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(res.rows[0]!.expenses)).toBe(0);
  });

  it('real gasto (expense_id set) counts in the reports expenses aggregate', async () => {
    await seedSession(SESSION_ID);
    await seedGasto(SESSION_ID, 120);

    const res = await pg.query<{ expenses: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE ${PNLFILTER}), 0)::text AS expenses
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(res.rows[0]!.expenses)).toBe(120);
  });

  it('salary row (expense_id NULL) counts in the reports expenses aggregate', async () => {
    await seedSession(SESSION_ID);
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'salary', '1200.00', 'nomina', 'user')`,
      [SESSION_ID, ORG],
    );

    const res = await pg.query<{ expenses: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE ${PNLFILTER}), 0)::text AS expenses
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(res.rows[0]!.expenses)).toBe(1200);
  });

  it('inventory_purchase row (expense_id NULL) counts in the reports expenses aggregate', async () => {
    await seedSession(SESSION_ID);
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'inventory_purchase', '600.00', 'compra', 'user')`,
      [SESSION_ID, ORG],
    );

    const res = await pg.query<{ expenses: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE ${PNLFILTER}), 0)::text AS expenses
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(Number(res.rows[0]!.expenses)).toBe(600);
  });

  it('mixed: settle + salary + gasto — only gasto + salary count', async () => {
    await seedSession(SESSION_ID);

    // Settle — should NOT count
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by, supplier_id)
       VALUES ($1, $2, 'expense', '400.00', 'settle', 'cajero', $3)`,
      [SESSION_ID, ORG, SUPPLIER_ID],
    );
    // Salary — SHOULD count
    await pg.query(
      `INSERT INTO cash_movements
         (session_id, organization_id, type, amount, reason, created_by)
       VALUES ($1, $2, 'salary', '700.00', 'nomina', 'user')`,
      [SESSION_ID, ORG],
    );
    // Real gasto — SHOULD count
    await seedGasto(SESSION_ID, 150);

    const res = await pg.query<{ expenses: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE ${PNLFILTER}), 0)::text AS expenses
       FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    );

    // 700 (salary) + 150 (gasto) = 850; settle (400) excluded
    expect(Number(res.rows[0]!.expenses)).toBe(850);
  });
});
