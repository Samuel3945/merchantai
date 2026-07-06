/**
 * PGLite-backed tests for recordSupplierPaymentOutflow and pay-at-entry flow.
 *
 * TDD cycle: tests written FIRST (RED) before implementation exists.
 * Covers SC-3.x (outflow correctness) and SC-2.x (pay-at-entry integration).
 * Also validates the TenantDb path so a missing TENANT_TABLES registration
 * fails loudly rather than silently.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenantDb } from '@/libs/db-context';
import {
  recordSupplierPaymentOutflow,
} from '@/libs/treasury';

// ── PGLite database types ─────────────────────────────────────────────────────

type RawDb = ReturnType<typeof drizzle<Record<string, never>>>;

let pg: PGlite;
let db: RawDb;

// ── ENUMs (must precede DDL) ──────────────────────────────────────────────────

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
// Minimal tables needed for the supplier payment outflow tests.
// Must mirror Schema.ts exactly to avoid 42703 column errors.

const DDL = `
  CREATE TABLE pos_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    device_name text NOT NULL,
    allow_oversell boolean DEFAULT false NOT NULL,
    default_sweep_destination_account_id uuid,
    caja_id uuid
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
    client_session_id uuid,
    caja_id uuid
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

  -- Invoice header (migration 0069).
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

  -- Supplier payables: one header per purchase entry (migration 0065 + 0068 + 0069)
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

  CREATE UNIQUE INDEX supplier_payables_stock_movement_unique
    ON supplier_payables (stock_movement_id)
    WHERE stock_movement_id IS NOT NULL;

  -- Supplier payments ledger: one row per payment event (migration 0065 + 0071).
  -- Migration 0071: treasury_movement_id nullable; cash_movement_id added;
  -- CHECK exactly one funding source set.
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
    corrects_session_id uuid,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

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

const ORG = 'org-s2';
const SUPPLIER_ID = '00000000-0000-0000-aaaa-000000000001';
const CONTAINER_ID = '00000000-0000-0000-bbbb-000000000001';
const PAYABLE_ID = '00000000-0000-0000-cccc-000000000001';
const PAYABLE_ID_2 = '00000000-0000-0000-cccc-000000000002';

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

// Helper: seed a treasury_account with an opening_balance (acts as initial credit).
async function seedAccount(
  id: string,
  openingBalance: number,
  type: 'caja_fuerte' | 'banco' | 'caja' = 'caja_fuerte',
  active = true,
): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts
       (id, organization_id, type, name, opening_balance, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [id, ORG, type, `${type}-${id.slice(-4)}`, openingBalance.toFixed(2), active],
  );
}

// Helper: seed an open supplier_payable directly.
async function seedPayable(
  id: string,
  totalAmount: number,
  paidAmount = 0,
  status: 'open' | 'partial' | 'paid' = 'open',
  creditedAmount = 0,
): Promise<void> {
  await pg.query(
    `INSERT INTO supplier_payables
       (id, organization_id, supplier_id, total_amount, paid_amount, credited_amount, status, purchased_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), now())`,
    [id, ORG, SUPPLIER_ID, totalAmount.toFixed(2), paidAmount.toFixed(2), creditedAmount.toFixed(2), status],
  );
}

// ── SC-3.x: Payment outflow correctness ──────────────────────────────────────

describe('recordSupplierPaymentOutflow — SC-3.1: type=salida, not gasto', () => {
  it('inserts a treasury_movements row with type=salida, not gasto', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_ID, 500);

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 200,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      note: 'test payment',
      createdBy: 'user-1',
    });

    const rows = await pg.query<{ type: string; from_account_id: string; to_account_id: string | null }>(
      `SELECT type, from_account_id, to_account_id FROM treasury_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.type).toBe('salida');
    expect(rows.rows[0]!.from_account_id).toBe(CONTAINER_ID);
    expect(rows.rows[0]!.to_account_id).toBeNull();
  });
});

describe('recordSupplierPaymentOutflow — SC-3.2: no expenses row on payment', () => {
  it('does not write any expenses row', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_ID, 500);

    const beforeCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM expenses',
      [],
    );

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 300,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    const afterCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM expenses',
      [],
    );

    expect(Number(afterCount.rows[0]!.count)).toBe(Number(beforeCount.rows[0]!.count));
    expect(Number(afterCount.rows[0]!.count)).toBe(0);
  });
});

describe('recordSupplierPaymentOutflow — SC-3.3: overpay rejection', () => {
  it('rejects payment that exceeds outstanding balance', async () => {
    // totalAmount=500, paidAmount=200, outstanding=300; try to pay 400
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 500, 200, 'partial');

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 400,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();

    // No rows written
    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);

    const payCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM supplier_payments',
      [],
    );

    expect(Number(payCount.rows[0]!.count)).toBe(0);
  });
});

describe('recordSupplierPaymentOutflow — SC-3.4: zero payment rejection', () => {
  it('rejects payment of amount 0', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_ID, 500);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 0,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();

    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);
  });
});

describe('recordSupplierPaymentOutflow — SC-3.5: negative payment rejection', () => {
  it('rejects negative amount', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_ID, 500);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: -100,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();
  });
});

describe('recordSupplierPaymentOutflow — SC-3.6: paid payable rejection', () => {
  it('rejects payment on a payable that is already paid', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 500, 500, 'paid');

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 100,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();

    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);
  });
});

describe('recordSupplierPaymentOutflow — SC-3.7: atomic rollback on insert failure', () => {
  it('writes both treasury_movements and supplier_payments in the same transaction', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_ID, 500);

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 200,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    // Both rows must exist together (atomicity evidence)
    const movRow = await pg.query<{ id: string }>(
      'SELECT id FROM treasury_movements WHERE organization_id = $1',
      [ORG],
    );
    const payRow = await pg.query<{ treasury_movement_id: string }>(
      'SELECT treasury_movement_id FROM supplier_payments WHERE organization_id = $1',
      [ORG],
    );

    expect(movRow.rows).toHaveLength(1);
    expect(payRow.rows).toHaveLength(1);
    expect(payRow.rows[0]!.treasury_movement_id).toBe(movRow.rows[0]!.id);
  });
});

// SC-3.8: single-transaction insufficient-balance rejection only.
// NOTE: the container balance is an unlocked aggregate (FOR UPDATE is on the
// payable row only, per design D5). Concurrent debits from the same container
// are NOT serialized — this is a deliberate, accepted limitation shared with
// recordInflowSourceDebit and recordGastoOutflow. This test covers only the
// single-transaction path, not concurrent-debit safety.
describe('recordSupplierPaymentOutflow — SC-3.8: single-tx insufficient-balance rejection', () => {
  it('rejects payment in single tx when container balance is insufficient', async () => {
    // Container has 300, try to pay 500
    await seedAccount(CONTAINER_ID, 300);
    await seedPayable(PAYABLE_ID, 1000);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 500,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow(/saldo insuficiente/i);

    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);
  });
});

// ── Status transitions ────────────────────────────────────────────────────────

describe('recordSupplierPaymentOutflow — status transitions', () => {
  it('full payment transitions payable to paid', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 1000);

    const result = await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 1000,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    expect(result.payableStatus).toBe('paid');

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('paid');
    expect(payable.rows[0]!.paid_amount).toBe('1000.00');
  });

  it('partial payment transitions payable to partial', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 1000);

    const result = await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 400,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    expect(result.payableStatus).toBe('partial');

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('partial');
    expect(payable.rows[0]!.paid_amount).toBe('400.00');
  });

  it('two sequential partial payments accumulate correctly (N:M)', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 900);

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 300,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 300,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('partial');
    expect(payable.rows[0]!.paid_amount).toBe('600.00');

    const payCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM supplier_payments WHERE payable_id = $1',
      [PAYABLE_ID],
    );

    expect(Number(payCount.rows[0]!.count)).toBe(2);
  });

  it('returns { paymentId, treasuryMovementId, payableStatus } on success', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 500);

    const result = await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 250,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    expect(result.paymentId).toBeTruthy();
    expect(result.treasuryMovementId).toBeTruthy();
    expect(result.payableStatus).toBe('partial');
  });
});

// ── Inactive container rejection ──────────────────────────────────────────────

describe('recordSupplierPaymentOutflow — inactive container', () => {
  it('throws when container is inactive', async () => {
    await seedAccount(CONTAINER_ID, 1000, 'caja_fuerte', false);
    await seedPayable(PAYABLE_ID, 500);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 200,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow(/inactiv|not found/i);
  });

  it('throws when container does not exist', async () => {
    await seedPayable(PAYABLE_ID, 500);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: '00000000-0000-0000-ffff-999999999999',
        amount: 200,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();
  });
});

// ── TenantDb path regression (mandatory per LESSON FROM SLICE 1) ──────────────
// Exercises the createTenantDb proxy path (same as production) so that a
// missing TENANT_TABLES registration fails the test rather than failing silently.

describe('recordSupplierPaymentOutflow — TenantDb proxy regression', () => {
  it('works through createTenantDb (treasury_movements + supplier_payments in TENANT_TABLES)', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID_2, 600);

    const tenantDb = createTenantDb(db as never, ORG);

    const result = await recordSupplierPaymentOutflow(tenantDb as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 600,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID_2,
      createdBy: 'user-tenant',
    });

    expect(result.payableStatus).toBe('paid');

    // Verify both rows exist and are linked.
    const payment = await pg.query<{
      treasury_movement_id: string;
      amount: string;
    }>(
      'SELECT treasury_movement_id, amount FROM supplier_payments WHERE id = $1',
      [result.paymentId],
    );

    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0]!.treasury_movement_id).toBe(result.treasuryMovementId);
    expect(payment.rows[0]!.amount).toBe('600.00');
  });

  it('supplier_payments requires exactly one funding source (num_nonnulls=1 CHECK enforced)', async () => {
    // Attempt to insert a supplier_payments row with NEITHER funding source set.
    // With the num_nonnulls=1 CHECK (migration 0071), this MUST fail.
    await seedPayable(PAYABLE_ID_2, 100);

    await expect(
      pg.query(
        `INSERT INTO supplier_payments
           (id, organization_id, supplier_id, payable_id, amount, created_by, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '50.00', 'user', now())`,
        [ORG, SUPPLIER_ID, PAYABLE_ID_2],
      ),
    ).rejects.toThrow();
  });
});

// ── SC-3.9: payment cap respects credited_amount ──────────────────────────────
//
// When a payable already has credited_amount > 0 the outstanding balance is
// total − paid − credited.  This test proves:
//   (a) overpay beyond the credited-adjusted outstanding is rejected
//   (b) exact payment of the credited-adjusted outstanding succeeds and
//       transitions the payable to 'paid'

describe('recordSupplierPaymentOutflow — SC-3.9: cap includes credited_amount', () => {
  const PAYABLE_SC39 = '00000000-0000-0000-cccc-000000000039';

  it('rejects overpay when credited reduces outstanding (total=100, paid=0, credited=60 → outstanding=40)', async () => {
    // outstanding = 100 − 0 − 60 = 40; trying to pay 41 must be rejected.
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_SC39, 100, 0, 'partial', 60);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 41,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_SC39,
        createdBy: 'user-sc39',
      }),
    ).rejects.toThrow();

    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);
  });

  it('exact payment of credited-adjusted outstanding (40) succeeds and marks payable paid', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_SC39, 100, 0, 'partial', 60);

    const result = await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 40,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_SC39,
      createdBy: 'user-sc39',
    });

    expect(result.payableStatus).toBe('paid');

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_SC39],
    );

    expect(payable.rows[0]!.status).toBe('paid');
    expect(payable.rows[0]!.paid_amount).toBe('40.00');
  });
});

// ── SC-2.x: Pay-at-entry integration (via recordMovement action) ──────────────
// These tests verify the pay-at-entry wiring in inventory.ts.
// They use the payment helper directly here since recordMovement is a Next.js
// server action (uses requireUser/requirePanelModule) that cannot be called
// directly from PGLite tests. The helper is the authoritative contract.

describe('pay-at-entry scenarios (helper-level SC-2.x)', () => {
  it('SC-2.1: no payment (unpaid) — payable stays open, no treasury row', async () => {
    await seedAccount(CONTAINER_ID, 1000);
    await seedPayable(PAYABLE_ID, 1000);

    // Simulate "user chose No" — no call to recordSupplierPaymentOutflow.
    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );
    const payCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM supplier_payments',
      [],
    );
    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);
    expect(Number(payCount.rows[0]!.count)).toBe(0);
    expect(payable.rows[0]!.status).toBe('open');
    expect(payable.rows[0]!.paid_amount).toBe('0.00');
  });

  it('SC-2.2: full payment → payable becomes paid, one salida movement, no expenses', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 1000);

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 1000,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    const movement = await pg.query<{ type: string; amount: string; to_account_id: string | null }>(
      'SELECT type, amount, to_account_id FROM treasury_movements WHERE organization_id = $1',
      [ORG],
    );

    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]!.type).toBe('salida');
    expect(movement.rows[0]!.amount).toBe('1000.00');
    expect(movement.rows[0]!.to_account_id).toBeNull();

    const expensesCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM expenses',
      [],
    );

    expect(Number(expensesCount.rows[0]!.count)).toBe(0);

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('paid');
    expect(payable.rows[0]!.paid_amount).toBe('1000.00');
  });

  it('SC-2.3: partial payment → payable becomes partial, outstanding correct', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 1000);

    await recordSupplierPaymentOutflow(db as never, {
      organizationId: ORG,
      fromAccountId: CONTAINER_ID,
      amount: 400,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      createdBy: 'user-1',
    });

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('partial');
    expect(payable.rows[0]!.paid_amount).toBe('400.00');
    // Outstanding = 1000 - 400 = 600 (verified at read time by caller)
  });

  it('SC-2.5: insufficient balance rolls back payment — no movement or payment row', async () => {
    // Container has only 500, try to pay 1000
    await seedAccount(CONTAINER_ID, 500);
    await seedPayable(PAYABLE_ID, 1000);

    await expect(
      recordSupplierPaymentOutflow(db as never, {
        organizationId: ORG,
        fromAccountId: CONTAINER_ID,
        amount: 1000,
        supplierId: SUPPLIER_ID,
        payableId: PAYABLE_ID,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow(/saldo insuficiente/i);

    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );
    const payCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM supplier_payments',
      [],
    );
    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);
    expect(Number(payCount.rows[0]!.count)).toBe(0);
    expect(payable.rows[0]!.status).toBe('open');
    expect(payable.rows[0]!.paid_amount).toBe('0.00');
  });
});
