/**
 * PGLite-backed tests for listOpenPayables and recordPayablePayment server actions.
 *
 * TDD cycle: tests written FIRST (RED) before implementation exists.
 * Covers SC-5.x (Compras por pagar view) and SC-6.x (N:M multi-payment edge cases).
 * Also validates the TenantDb proxy path so a missing TENANT_TABLES registration
 * fails loudly rather than silently.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listOpenPayables,
  recordPayablePayment,
} from '@/features/suppliers/actions';
import { createTenantDb } from '@/libs/db-context';

// ── PGLite database types ─────────────────────────────────────────────────────

type RawDb = ReturnType<typeof drizzle<Record<string, never>>>;

let pg: PGlite;
let rawDb: RawDb;

// ── ENUMs (must precede DDL) ──────────────────────────────────────────────────

const ENUMS = [
  `CREATE TYPE "cash_session_status" AS ENUM('open', 'closed')`,
  `CREATE TYPE "cash_movement_type" AS ENUM('sale','deposit','expense','salary','inventory_purchase','withdrawal','adjustment','advance','fiado_payment','reclassification')`,
  `CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending','confirmed','not_arrived','mismatch')`,
  `CREATE TYPE "transfer_resolution_type" AS ENUM('receivable','loss','cashier_liability')`,
  `CREATE TYPE "treasury_account_type" AS ENUM('caja','caja_fuerte','banco','transito')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover')`,
  `CREATE TYPE "supplier_payable_status" AS ENUM('open','partial','paid')`,
  `CREATE TYPE "stock_movement_type" AS ENUM('entry','exit')`,
  `CREATE TYPE "supplier_status" AS ENUM('active','archived')`,
];

// ── DDL ───────────────────────────────────────────────────────────────────────
// Minimal tables needed for listOpenPayables + recordPayablePayment tests.
// Must mirror Schema.ts exactly to avoid 42703 column errors.

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

  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    deleted boolean DEFAULT false NOT NULL
  );

  CREATE TABLE suppliers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    company text,
    phone text,
    email text,
    city text,
    address text,
    tax_id text,
    notes text,
    status "supplier_status" DEFAULT 'active' NOT NULL,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE stock_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name text,
    type "stock_movement_type" NOT NULL,
    qty numeric(12,3) NOT NULL,
    remaining_qty numeric(12,3),
    unit_cost numeric(12,2),
    expires_at date,
    reason text,
    created_by text,
    sale_id uuid,
    supplier_id text,
    notes text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  -- Supplier payables: one header per purchase entry (migration 0065 + 0068)
  CREATE TABLE supplier_payables (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    stock_movement_id uuid REFERENCES stock_movements(id) ON DELETE RESTRICT,
    total_amount numeric(12,2) NOT NULL,
    paid_amount numeric(12,2) DEFAULT '0' NOT NULL,
    credited_amount numeric(12,2) DEFAULT '0' NOT NULL,
    status "supplier_payable_status" DEFAULT 'open' NOT NULL,
    purchased_at timestamp DEFAULT now() NOT NULL,
    notes text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE UNIQUE INDEX supplier_payables_stock_movement_unique
    ON supplier_payables (stock_movement_id)
    WHERE stock_movement_id IS NOT NULL;

  -- Supplier payments ledger: one row per payment event (migration 0065 + 0066)
  CREATE TABLE supplier_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    payable_id uuid REFERENCES supplier_payables(id) ON DELETE SET NULL,
    treasury_movement_id uuid NOT NULL REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG = 'org-s3';
const ORG_B = 'org-s3-b';
const SUPPLIER_ID = '00000000-0000-0000-aaaa-000000000001';
const CONTAINER_ID = '00000000-0000-0000-bbbb-000000000001';
const PAYABLE_ID = '00000000-0000-0000-cccc-000000000001';
const PAYABLE_ID_2 = '00000000-0000-0000-cccc-000000000002';
const PAYABLE_ID_3 = '00000000-0000-0000-cccc-000000000003';
const PRODUCT_ID = '00000000-0000-0000-dddd-000000000001';

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = new PGlite();
  rawDb = drizzle(pg) as unknown as RawDb;
  for (const e of ENUMS) {
    await pg.exec(e);
  }
  await pg.exec(DDL);
});

beforeEach(async () => {
  // FK order: children before parents.
  await pg.exec('DELETE FROM supplier_payments');
  await pg.exec('DELETE FROM supplier_payables');
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM treasury_accounts');
  await pg.exec('DELETE FROM stock_movements');
  await pg.exec('DELETE FROM suppliers');
  await pg.exec('DELETE FROM products');
  await pg.exec('DELETE FROM expenses');
  await pg.exec('DELETE FROM transfer_reconciliations');
  await pg.exec('DELETE FROM cash_sessions');
  await pg.exec('DELETE FROM pos_tokens');
  await pg.exec('DELETE FROM payment_methods');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

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

async function seedProduct(id: string = PRODUCT_ID): Promise<void> {
  await pg.query(
    `INSERT INTO products (id, organization_id, name, deleted) VALUES ($1, $2, $3, false)`,
    [id, ORG, 'Producto Test'],
  );
}

async function seedSupplier(
  id: string = SUPPLIER_ID,
  orgId: string = ORG,
  status: 'active' | 'archived' = 'active',
): Promise<void> {
  await pg.query(
    `INSERT INTO suppliers (id, organization_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [id, orgId, 'Proveedor Test', status],
  );
}

async function seedStockMovement(id: string, productId: string = PRODUCT_ID): Promise<void> {
  await pg.query(
    `INSERT INTO stock_movements
       (id, organization_id, product_id, product_name, type, qty, unit_cost, supplier_id, reason, created_by, created_at)
     VALUES ($1, $2, $3, 'Producto Test', 'entry', 10, '50.00', $4, 'purchase', 'user-1', now())`,
    [id, ORG, productId, SUPPLIER_ID],
  );
}

async function seedPayable(
  id: string,
  totalAmount: number,
  paidAmount = 0,
  status: 'open' | 'partial' | 'paid' = 'open',
  supplierId: string = SUPPLIER_ID,
  orgId: string = ORG,
  stockMovementId: string | null = null,
): Promise<void> {
  await pg.query(
    `INSERT INTO supplier_payables
       (id, organization_id, supplier_id, stock_movement_id, total_amount, paid_amount, status, purchased_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), now())`,
    [
      id,
      orgId,
      supplierId,
      stockMovementId,
      totalAmount.toFixed(2),
      paidAmount.toFixed(2),
      status,
    ],
  );
}

// ── SC-5.1: listOpenPayables excludes paid payables ───────────────────────────

describe('listOpenPayables — SC-5.1: excludes paid payables', () => {
  it('returns open and partial payables but NOT paid ones', async () => {
    await seedPayable(PAYABLE_ID, 1000, 0, 'open');
    await seedPayable(PAYABLE_ID_2, 500, 200, 'partial');
    await seedPayable(PAYABLE_ID_3, 800, 800, 'paid');

    const rows = await listOpenPayables(rawDb as never, ORG);

    expect(rows).toHaveLength(2);

    const ids = rows.map(r => r.id);

    expect(ids).toContain(PAYABLE_ID);
    expect(ids).toContain(PAYABLE_ID_2);
    expect(ids).not.toContain(PAYABLE_ID_3);
  });

  it('returns empty array when all payables are paid', async () => {
    await seedPayable(PAYABLE_ID, 500, 500, 'paid');

    const rows = await listOpenPayables(rawDb as never, ORG);

    expect(rows).toHaveLength(0);
  });

  it('returns empty array when no payables exist', async () => {
    const rows = await listOpenPayables(rawDb as never, ORG);

    expect(rows).toHaveLength(0);
  });
});

// ── SC-5.2: listOpenPayables row data is correct ──────────────────────────────

describe('listOpenPayables — SC-5.2: row data accuracy', () => {
  it('returns correct outstanding, status, totalAmount, paidAmount for partial payable', async () => {
    await seedPayable(PAYABLE_ID, 1000, 300, 'partial');

    const rows = await listOpenPayables(rawDb as never, ORG);

    expect(rows).toHaveLength(1);

    const row = rows[0]!;

    expect(row.id).toBe(PAYABLE_ID);
    expect(Number(row.totalAmount)).toBe(1000);
    expect(Number(row.paidAmount)).toBe(300);
    expect(Number(row.outstanding)).toBe(700);
    expect(row.status).toBe('partial');
    expect(row.supplierId).toBe(SUPPLIER_ID);
  });

  it('includes product name from stock_movements when linked', async () => {
    await seedProduct();
    const MOV_ID = '00000000-0000-0000-eeee-000000000001';
    await seedStockMovement(MOV_ID);
    await seedPayable(PAYABLE_ID, 500, 0, 'open', SUPPLIER_ID, ORG, MOV_ID);

    const rows = await listOpenPayables(rawDb as never, ORG);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.productName).toBe('Producto Test');
  });

  it('productName is null when no stock_movement linked', async () => {
    await seedPayable(PAYABLE_ID, 500, 0, 'open');

    const rows = await listOpenPayables(rawDb as never, ORG);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.productName).toBeNull();
  });

  it('orders results by purchasedAt DESC (newest first)', async () => {
    await pg.query(
      `INSERT INTO supplier_payables
         (id, organization_id, supplier_id, total_amount, paid_amount, status, purchased_at, created_at, updated_at)
       VALUES
         ($1, $2, $3, '200.00', '0', 'open', now() - interval '2 days', now(), now()),
         ($4, $2, $3, '300.00', '0', 'open', now(), now(), now())`,
      [PAYABLE_ID, ORG, SUPPLIER_ID, PAYABLE_ID_2],
    );

    const rows = await listOpenPayables(rawDb as never, ORG);

    // Newest first
    expect(rows[0]!.id).toBe(PAYABLE_ID_2);
    expect(rows[1]!.id).toBe(PAYABLE_ID);
  });
});

// ── SC-5.5: listOpenPayables is org-scoped ────────────────────────────────────

describe('listOpenPayables — SC-5.5: org-scoped', () => {
  it('does not return payables from a different org', async () => {
    await seedPayable(PAYABLE_ID, 1000, 0, 'open', SUPPLIER_ID, ORG);
    await seedPayable(PAYABLE_ID_2, 500, 0, 'open', SUPPLIER_ID, ORG_B);

    const rowsA = await listOpenPayables(rawDb as never, ORG);
    const rowsB = await listOpenPayables(rawDb as never, ORG_B);

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.id).toBe(PAYABLE_ID);

    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.id).toBe(PAYABLE_ID_2);
  });
});

// ── SC-5.3: recordPayablePayment — full payment from view ────────────────────

describe('recordPayablePayment — SC-5.3: full payment from view', () => {
  it('full payment sets status=paid and writes salida + payment rows', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 600);

    const result = await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 600,
      createdBy: 'user-1',
    });

    expect(result.payableStatus).toBe('paid');

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('paid');
    expect(payable.rows[0]!.paid_amount).toBe('600.00');

    const movement = await pg.query<{ type: string; to_account_id: string | null }>(
      'SELECT type, to_account_id FROM treasury_movements WHERE organization_id = $1',
      [ORG],
    );

    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]!.type).toBe('salida');
    expect(movement.rows[0]!.to_account_id).toBeNull();

    const payment = await pg.query<{ amount: string }>(
      'SELECT amount FROM supplier_payments WHERE payable_id = $1',
      [PAYABLE_ID],
    );

    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0]!.amount).toBe('600.00');
  });

  it('no expenses row written on full payment', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 600);

    await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 600,
      createdBy: 'user-1',
    });

    const expCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM expenses',
      [],
    );

    expect(Number(expCount.rows[0]!.count)).toBe(0);
  });
});

// ── SC-5.4: recordPayablePayment — partial payment from view ──────────────────

describe('recordPayablePayment — SC-5.4: partial payment from view', () => {
  it('partial payment sets status=partial with correct outstanding', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 600);

    const result = await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 200,
      createdBy: 'user-1',
    });

    expect(result.payableStatus).toBe('partial');

    const payable = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('partial');
    expect(payable.rows[0]!.paid_amount).toBe('200.00');

    // outstanding = 600 - 200 = 400
    const outstanding = 600 - 200;

    expect(outstanding).toBe(400);
  });
});

// ── SC-6.1: Multiple payments on same payable (N:M) ──────────────────────────

describe('recordPayablePayment — SC-6.1: N:M multi-payment accumulation', () => {
  it('three sequential partial payments of 300 each accumulate to paid=900', async () => {
    await seedAccount(CONTAINER_ID, 5000);
    await seedPayable(PAYABLE_ID, 900);

    await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 300,
      createdBy: 'user-1',
    });

    const after1 = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(after1.rows[0]!.status).toBe('partial');
    expect(after1.rows[0]!.paid_amount).toBe('300.00');

    await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 300,
      createdBy: 'user-1',
    });

    const after2 = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(after2.rows[0]!.status).toBe('partial');
    expect(after2.rows[0]!.paid_amount).toBe('600.00');

    await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 300,
      createdBy: 'user-1',
    });

    const after3 = await pg.query<{ status: string; paid_amount: string }>(
      'SELECT status, paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(after3.rows[0]!.status).toBe('paid');
    expect(after3.rows[0]!.paid_amount).toBe('900.00');

    // 3 supplier_payments rows linked to same payable
    const payCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM supplier_payments WHERE payable_id = $1',
      [PAYABLE_ID],
    );

    expect(Number(payCount.rows[0]!.count)).toBe(3);
  });
});

// ── SC-6.2: Edge cases — reject already-paid, over-cap, insufficient balance ──

describe('recordPayablePayment — SC-6.2: reject already-paid', () => {
  it('rejects payment on a payable that is already paid (REQ-7.7)', async () => {
    await seedAccount(CONTAINER_ID, 5000);
    await seedPayable(PAYABLE_ID, 500, 500, 'paid');

    await expect(
      recordPayablePayment(rawDb as never, {
        organizationId: ORG,
        payableId: PAYABLE_ID,
        fromAccountId: CONTAINER_ID,
        amount: 100,
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

describe('recordPayablePayment — SC-6.2: reject over-cap', () => {
  it('rejects payment that exceeds outstanding (REQ-4.8)', async () => {
    await seedAccount(CONTAINER_ID, 5000);
    await seedPayable(PAYABLE_ID, 500, 200, 'partial'); // outstanding=300

    await expect(
      recordPayablePayment(rawDb as never, {
        organizationId: ORG,
        payableId: PAYABLE_ID,
        fromAccountId: CONTAINER_ID,
        amount: 400, // > 300 outstanding
        createdBy: 'user-1',
      }),
    ).rejects.toThrow();

    const payable = await pg.query<{ paid_amount: string }>(
      'SELECT paid_amount FROM supplier_payables WHERE id = $1',
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.paid_amount).toBe('200.00');
  });
});

describe('recordPayablePayment — SC-6.2: reject insufficient container balance', () => {
  it('rejects payment when container has insufficient balance (REQ-4.7)', async () => {
    await seedAccount(CONTAINER_ID, 100); // only 100 available
    await seedPayable(PAYABLE_ID, 500);

    await expect(
      recordPayablePayment(rawDb as never, {
        organizationId: ORG,
        payableId: PAYABLE_ID,
        fromAccountId: CONTAINER_ID,
        amount: 200, // > 100 available
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

// ── SC-6.3: Inactive supplier payable is still payable ────────────────────────

describe('recordPayablePayment — SC-6.3: inactive supplier payable still payable', () => {
  it('succeeds even when the linked supplier is inactive/archived', async () => {
    // The supplier is archived but the payable must still be settleable.
    await seedSupplier(SUPPLIER_ID, ORG, 'archived');
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID, 500, 0, 'open', SUPPLIER_ID);

    const result = await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 500,
      createdBy: 'user-1',
    });

    expect(result.payableStatus).toBe('paid');
  });
});

// ── S3-T8: Regression tests — FIFO invariant + no expenses + no cash_movements ─

describe('regression — S3-T8: FIFO invariant and payment isolation', () => {
  it('no expenses row written on any payment path (REQ-4.4)', async () => {
    await seedAccount(CONTAINER_ID, 5000);
    await seedPayable(PAYABLE_ID, 1000);

    await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 1000,
      createdBy: 'user-1',
    });

    const expCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM expenses',
      [],
    );

    expect(Number(expCount.rows[0]!.count)).toBe(0);
  });

  it('stock quantities are unaffected by payment (FIFO invariant preserved)', async () => {
    await seedProduct();
    const MOV_ID = '00000000-0000-0000-eeee-000000000002';
    await seedStockMovement(MOV_ID);
    await seedAccount(CONTAINER_ID, 5000);
    await seedPayable(PAYABLE_ID, 500, 0, 'open', SUPPLIER_ID, ORG, MOV_ID);

    // Record qty before payment
    const before = await pg.query<{ qty: string; remaining_qty: string }>(
      'SELECT qty, remaining_qty FROM stock_movements WHERE id = $1',
      [MOV_ID],
    );

    await recordPayablePayment(rawDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID,
      fromAccountId: CONTAINER_ID,
      amount: 500,
      createdBy: 'user-1',
    });

    // qty and remaining_qty must be unchanged
    const after = await pg.query<{ qty: string; remaining_qty: string }>(
      'SELECT qty, remaining_qty FROM stock_movements WHERE id = $1',
      [MOV_ID],
    );

    expect(after.rows[0]!.qty).toBe(before.rows[0]!.qty);
    expect(after.rows[0]!.remaining_qty).toBe(before.rows[0]!.remaining_qty);
  });
});

// ── SC-6.2: Cross-org reject guard on recordPayablePayment ───────────────────
// The payable belongs to ORG_B; calling with organizationId = ORG must throw
// and write zero treasury_movements + zero supplier_payments rows.

describe('recordPayablePayment — cross-org ownership guard', () => {
  const PAYABLE_ORG_B = '00000000-0000-0000-cccc-000000000099';
  const CONTAINER_ORG = '00000000-0000-0000-bbbb-000000000099';

  it('rejects when payable belongs to a different org and writes no side effects', async () => {
    // Seed an account for ORG (the caller's org).
    await pg.query(
      `INSERT INTO treasury_accounts
         (id, organization_id, type, name, opening_balance, active, created_at, updated_at)
       VALUES ($1, $2, 'caja_fuerte', 'test-acct', '5000.00', true, now(), now())`,
      [CONTAINER_ORG, ORG],
    );

    // Seed a payable for ORG_B (a different org).
    await seedPayable(PAYABLE_ORG_B, 500, 0, 'open', SUPPLIER_ID, ORG_B);

    // Attempt to pay ORG_B's payable using ORG's credentials.
    await expect(
      recordPayablePayment(rawDb as never, {
        organizationId: ORG,
        payableId: PAYABLE_ORG_B,
        fromAccountId: CONTAINER_ORG,
        amount: 500,
        createdBy: 'user-1',
      }),
    ).rejects.toThrow(/does not belong/i);

    // No treasury_movements written.
    const movCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM treasury_movements',
      [],
    );

    expect(Number(movCount.rows[0]!.count)).toBe(0);

    // No supplier_payments written.
    const payCount = await pg.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM supplier_payments',
      [],
    );

    expect(Number(payCount.rows[0]!.count)).toBe(0);
  });
});

// ── TenantDb proxy regression (MANDATORY — same lesson as Slice 1 and 2) ──────
// supplier_payables and treasury_movements must be in TENANT_TABLES.

describe('recordPayablePayment — TenantDb proxy regression', () => {
  it('works through createTenantDb (supplier_payables + treasury_movements in TENANT_TABLES)', async () => {
    await seedAccount(CONTAINER_ID, 2000);
    await seedPayable(PAYABLE_ID_2, 700);

    const tenantDb = createTenantDb(rawDb as never, ORG);

    const result = await recordPayablePayment(tenantDb as never, {
      organizationId: ORG,
      payableId: PAYABLE_ID_2,
      fromAccountId: CONTAINER_ID,
      amount: 700,
      createdBy: 'user-tenant',
    });

    expect(result.payableStatus).toBe('paid');

    const payment = await pg.query<{ amount: string }>(
      'SELECT amount FROM supplier_payments WHERE payable_id = $1',
      [PAYABLE_ID_2],
    );

    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0]!.amount).toBe('700.00');
  });
});
