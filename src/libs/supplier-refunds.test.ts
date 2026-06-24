/**
 * PGLite-backed tests for supplier return refund logic.
 *
 * TDD cycle: tests written FIRST (RED) before implementation.
 * Covers SR-11 through SR-16 per the design spec.
 *
 * SR-11: writeLotReturnCredit — pure credit, payable outstanding reduced, no treasury row.
 * SR-12: returnLot lib — pure refund (outstanding=0), treasury_movements row inserted
 *        (type='refund', to=container), supplier_refunds row inserted, no credit row.
 * SR-13: returnLot lib — split (partial outstanding), both credit and refund rows inserted.
 * SR-14: returnLot lib — qty > remaining → throws qty_exceeds_remaining, no side effects.
 * SR-15: returnLot lib — refundPortion > 0 with no container → throws refund_container_required.
 * SR-16: supplier_refunds in TENANT_TABLES proxy regression.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenantDb } from '@/libs/db-context';
import { returnLot } from '@/libs/supplier-refunds';
import { writeLotReturnCredit } from '@/libs/supplier-returns';

// ── PGLite database types ─────────────────────────────────────────────────────

type RawDb = ReturnType<typeof drizzle<Record<string, never>>>;

let pg: PGlite;
let db: RawDb;

// ── ENUMs ─────────────────────────────────────────────────────────────────────
// Must include 'refund' as the migration 0070 adds it.

const ENUMS = [
  `CREATE TYPE "supplier_payable_status" AS ENUM('open','partial','paid')`,
  `CREATE TYPE "stock_movement_type" AS ENUM('entry','exit')`,
  `CREATE TYPE "treasury_movement_type" AS ENUM('transfer','consignacion','entrada','salida','gasto','adjustment','handover','refund')`,
];

// ── DDL ───────────────────────────────────────────────────────────────────────
// Must mirror Schema.ts exactly (42703 lesson).

const DDL = `
  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    stock numeric(12,3) DEFAULT 0 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
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
    stock_movement_id uuid REFERENCES stock_movements(id) ON DELETE RESTRICT,
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

  CREATE TABLE supplier_payable_credits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    payable_id uuid REFERENCES supplier_payables(id) ON DELETE SET NULL,
    return_stock_movement_id uuid NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE treasury_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    opening_balance numeric(12,2) DEFAULT '0' NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
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
        AND type::text IN ('entrada', 'salida', 'gasto', 'consignacion', 'adjustment', 'handover', 'refund')
      )
    )
  );

  -- Minimal cash_movements stub — FK target for supplier_payments (migration 0071).
  -- supplier-refunds tests do not exercise cash_movements directly.
  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    organization_id text NOT NULL,
    type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
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

  CREATE TABLE supplier_refunds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    supplier_id text NOT NULL,
    payable_id uuid REFERENCES supplier_payables(id) ON DELETE SET NULL,
    stock_movement_id uuid NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
    treasury_movement_id uuid NOT NULL REFERENCES treasury_movements(id) ON DELETE RESTRICT,
    amount numeric(12,2) NOT NULL,
    note text,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG = 'org-sr-refund-1';
const SUPPLIER_ID = '00000000-0000-0000-aaaa-000000000001';
const PRODUCT_ID = '00000000-0000-0000-dddd-000000000001';
const LOT_ID = '00000000-0000-0000-eeee-000000000001';
const PAYABLE_ID = '00000000-0000-0000-cccc-000000000001';
const CONTAINER_ID = '00000000-0000-0000-ffff-000000000001';

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
  await pg.exec('DELETE FROM supplier_refunds');
  await pg.exec('DELETE FROM supplier_payments');
  await pg.exec('DELETE FROM treasury_movements');
  await pg.exec('DELETE FROM supplier_payable_credits');
  await pg.exec('DELETE FROM supplier_payables');
  await pg.exec('DELETE FROM stock_movements');
  await pg.exec('DELETE FROM products');
  await pg.exec('DELETE FROM treasury_accounts');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedProduct(id: string = PRODUCT_ID, stock = 10): Promise<void> {
  await pg.query(
    `INSERT INTO products (id, organization_id, name, stock, deleted) VALUES ($1, $2, $3, $4, false)`,
    [id, ORG, 'Producto Test', stock],
  );
}

async function seedLot(
  id: string = LOT_ID,
  qty = 10,
  remainingQty = 10,
  unitCost = '100.00',
): Promise<void> {
  await pg.query(
    `INSERT INTO stock_movements
       (id, organization_id, product_id, type, qty, remaining_qty, unit_cost, supplier_id, reason, created_at)
     VALUES ($1, $2, $3, 'entry', $4, $5, $6, $7, 'purchase', now())`,
    [id, ORG, PRODUCT_ID, qty, remainingQty, unitCost, SUPPLIER_ID],
  );
}

async function seedPayable(
  id: string = PAYABLE_ID,
  totalAmount: number,
  paidAmount = 0,
  creditedAmount = 0,
  status: 'open' | 'partial' | 'paid' = 'open',
  lotId: string = LOT_ID,
): Promise<void> {
  await pg.query(
    `INSERT INTO supplier_payables
       (id, organization_id, supplier_id, stock_movement_id, total_amount, paid_amount, credited_amount, status, purchased_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`,
    [id, ORG, SUPPLIER_ID, lotId, totalAmount.toFixed(2), paidAmount.toFixed(2), creditedAmount.toFixed(2), status],
  );
}

async function seedContainer(id: string = CONTAINER_ID): Promise<void> {
  await pg.query(
    `INSERT INTO treasury_accounts (id, organization_id, name, type, opening_balance, is_active)
     VALUES ($1, $2, 'Caja Fuerte', 'caja_fuerte', '0', true)`,
    [id, ORG],
  );
}

// ── SR-11: writeLotReturnCredit — pure credit ─────────────────────────────────

describe('writeLotReturnCredit — SR-11: pure credit, no treasury row', () => {
  it('writes one credit row and bumps credited_amount; does NOT touch treasury_movements', async () => {
    await seedProduct();
    await seedLot(LOT_ID, 10, 5, '100.00'); // unitCost=100, remainingQty=5
    await seedPayable(PAYABLE_ID, 1000, 0, 0, 'open'); // totalAmount=1000, fully open

    // Insert an exit stock_movements row to reference (the credit needs a return movement)
    const exitId = '00000000-0000-0000-eeee-000000000002';
    await pg.query(
      `INSERT INTO stock_movements (id, organization_id, product_id, type, qty, created_at)
       VALUES ($1, $2, $3, 'exit', 3, now())`,
      [exitId, ORG, PRODUCT_ID],
    );

    await writeLotReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      exitMovementId: exitId,
      creditPortion: 300,
      createdBy: 'user-sr11',
    });

    // One credit row written
    const credits = await pg.query<{ amount: string; payable_id: string }>(
      `SELECT amount, payable_id FROM supplier_payable_credits WHERE organization_id = $1`,
      [ORG],
    );

    expect(credits.rows).toHaveLength(1);
    expect(Number(credits.rows[0]!.amount)).toBeCloseTo(300, 2);
    expect(credits.rows[0]!.payable_id).toBe(PAYABLE_ID);

    // credited_amount bumped
    const payable = await pg.query<{ credited_amount: string; status: string }>(
      `SELECT credited_amount, status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID],
    );

    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(300, 2);
    expect(payable.rows[0]!.status).toBe('partial');

    // No treasury_movements touched
    const tmRows = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM treasury_movements`,
      [],
    );

    expect(Number(tmRows.rows[0]!.count)).toBe(0);
  });

  it('marks payable as paid when creditPortion covers outstanding exactly', async () => {
    await seedProduct();
    await seedLot();
    await seedPayable(PAYABLE_ID, 300, 0, 0, 'open'); // outstanding=300

    const exitId = '00000000-0000-0000-eeee-000000000003';
    await pg.query(
      `INSERT INTO stock_movements (id, organization_id, product_id, type, qty, created_at)
       VALUES ($1, $2, $3, 'exit', 3, now())`,
      [exitId, ORG, PRODUCT_ID],
    );

    await writeLotReturnCredit(db as never, {
      organizationId: ORG,
      supplierId: SUPPLIER_ID,
      payableId: PAYABLE_ID,
      exitMovementId: exitId,
      creditPortion: 300,
      createdBy: 'user-sr11b',
    });

    const payable = await pg.query<{ status: string; credited_amount: string }>(
      `SELECT status, credited_amount FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID],
    );

    expect(payable.rows[0]!.status).toBe('paid');
    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(300, 2);
  });
});

// ── SR-12: returnLot — pure refund (outstanding=0) ───────────────────────────

describe('returnLot — SR-12: pure refund when payable is fully paid', () => {
  it('writes treasury_movements(type=refund, to=container) and supplier_refunds; NO credit row', async () => {
    await seedProduct(PRODUCT_ID, 10);
    await seedLot(LOT_ID, 10, 5, '100.00'); // unitCost=100
    await seedContainer();
    // Fully paid payable → outstanding=0 → all returnValue becomes refund
    await seedPayable(PAYABLE_ID, 500, 500, 0, 'paid');

    await returnLot(db as never, {
      organizationId: ORG,
      lotId: LOT_ID,
      qtyReturned: 2,
      refundContainerId: CONTAINER_ID,
      createdBy: 'user-sr12',
    });

    // Treasury movement: type='refund', from=null, to=container, amount=200
    const tmRows = await pg.query<{
      type: string;
      from_account_id: string | null;
      to_account_id: string;
      amount: string;
    }>(
      `SELECT type, from_account_id, to_account_id, amount FROM treasury_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(tmRows.rows).toHaveLength(1);
    expect(tmRows.rows[0]!.type).toBe('refund');
    expect(tmRows.rows[0]!.from_account_id).toBeNull();
    expect(tmRows.rows[0]!.to_account_id).toBe(CONTAINER_ID);
    expect(Number(tmRows.rows[0]!.amount)).toBeCloseTo(200, 2);

    // supplier_refunds row
    const refunds = await pg.query<{ amount: string; payable_id: string }>(
      `SELECT amount, payable_id FROM supplier_refunds WHERE organization_id = $1`,
      [ORG],
    );

    expect(refunds.rows).toHaveLength(1);
    expect(Number(refunds.rows[0]!.amount)).toBeCloseTo(200, 2);
    expect(refunds.rows[0]!.payable_id).toBe(PAYABLE_ID);

    // NO supplier_payable_credits row (creditPortion=0)
    const credits = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_payable_credits`,
      [],
    );

    expect(Number(credits.rows[0]!.count)).toBe(0);

    // lot remaining_qty decremented
    const lot = await pg.query<{ remaining_qty: string }>(
      `SELECT remaining_qty FROM stock_movements WHERE id = $1`,
      [LOT_ID],
    );

    expect(Number(lot.rows[0]!.remaining_qty)).toBeCloseTo(3, 3);

    // product stock decremented
    const product = await pg.query<{ stock: string }>(
      `SELECT stock FROM products WHERE id = $1`,
      [PRODUCT_ID],
    );

    expect(Number(product.rows[0]!.stock)).toBeCloseTo(8, 3);
  });

  it('does NOT write supplier_payments (paidThisMonth KPI unaffected)', async () => {
    await seedProduct(PRODUCT_ID, 10);
    await seedLot(LOT_ID, 10, 3, '50.00');
    await seedContainer();
    await seedPayable(PAYABLE_ID, 150, 150, 0, 'paid');

    await returnLot(db as never, {
      organizationId: ORG,
      lotId: LOT_ID,
      qtyReturned: 1,
      refundContainerId: CONTAINER_ID,
      createdBy: 'user-sr12b',
    });

    // Assert no supplier_payments row was created (paidThisMonth KPI untouched)
    const payments = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_payments`,
      [],
    );

    expect(Number(payments.rows[0]!.count)).toBe(0);
  });
});

// ── SR-13: returnLot — split (partial outstanding) ───────────────────────────

describe('returnLot — SR-13: split return (creditPortion + refundPortion)', () => {
  it('writes both credit and refund rows when returnValue > outstanding > 0', async () => {
    await seedProduct(PRODUCT_ID, 10);
    // unitCost=100, so 3 units → returnValue=300
    await seedLot(LOT_ID, 10, 5, '100.00');
    await seedContainer();
    // outstanding = 500 - 200 - 0 = 300, but returnValue=300 → split: credit=300, refund=0
    // Let's make outstanding=100 and returnValue=300 → credit=100, refund=200
    await seedPayable(PAYABLE_ID, 500, 400, 0, 'partial'); // outstanding=100

    await returnLot(db as never, {
      organizationId: ORG,
      lotId: LOT_ID,
      qtyReturned: 3,
      refundContainerId: CONTAINER_ID,
      createdBy: 'user-sr13',
    });

    // Credit portion = min(300, 100) = 100
    const credits = await pg.query<{ amount: string }>(
      `SELECT amount FROM supplier_payable_credits WHERE organization_id = $1`,
      [ORG],
    );

    expect(credits.rows).toHaveLength(1);
    expect(Number(credits.rows[0]!.amount)).toBeCloseTo(100, 2);

    // Refund portion = 300 - 100 = 200
    const refunds = await pg.query<{ amount: string }>(
      `SELECT amount FROM supplier_refunds WHERE organization_id = $1`,
      [ORG],
    );

    expect(refunds.rows).toHaveLength(1);
    expect(Number(refunds.rows[0]!.amount)).toBeCloseTo(200, 2);

    // Treasury movement for refund
    const tmRows = await pg.query<{ amount: string; type: string }>(
      `SELECT amount, type FROM treasury_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(tmRows.rows).toHaveLength(1);
    expect(Number(tmRows.rows[0]!.amount)).toBeCloseTo(200, 2);
    expect(tmRows.rows[0]!.type).toBe('refund');

    // payable credited_amount bumped to 0+100=100, status becomes partial (paid+credited=400+100=500=total → paid)
    const payable = await pg.query<{ credited_amount: string; status: string }>(
      `SELECT credited_amount, status FROM supplier_payables WHERE id = $1`,
      [PAYABLE_ID],
    );

    expect(Number(payable.rows[0]!.credited_amount)).toBeCloseTo(100, 2);
    expect(payable.rows[0]!.status).toBe('paid');
  });
});

// ── SR-14: returnLot — qty > remaining → throws ───────────────────────────────

describe('returnLot — SR-14: qty > lot remaining → throws, no side effects', () => {
  it('throws qty_exceeds_remaining before any write', async () => {
    await seedProduct();
    await seedLot(LOT_ID, 10, 3, '100.00'); // remainingQty=3
    await seedContainer();
    await seedPayable(PAYABLE_ID, 1000, 0, 0, 'open');

    await expect(
      returnLot(db as never, {
        organizationId: ORG,
        lotId: LOT_ID,
        qtyReturned: 5, // > 3
        refundContainerId: CONTAINER_ID,
        createdBy: 'user-sr14',
      }),
    ).rejects.toThrow('qty_exceeds_remaining');

    // No side effects
    const credits = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_payable_credits`,
      [],
    );

    expect(Number(credits.rows[0]!.count)).toBe(0);

    const refunds = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_refunds`,
      [],
    );

    expect(Number(refunds.rows[0]!.count)).toBe(0);

    // lot remaining_qty unchanged
    const lot = await pg.query<{ remaining_qty: string }>(
      `SELECT remaining_qty FROM stock_movements WHERE id = $1`,
      [LOT_ID],
    );

    expect(Number(lot.rows[0]!.remaining_qty)).toBeCloseTo(3, 3);
  });
});

// ── SR-15: returnLot — refundPortion > 0 with no container → throws ───────────

describe('returnLot — SR-15: refundPortion > 0 with no container → throws', () => {
  it('throws refund_container_required when refund > 0 and no container given', async () => {
    await seedProduct(PRODUCT_ID, 10);
    await seedLot(LOT_ID, 10, 5, '100.00');
    // Fully paid payable → outstanding=0 → all refund, container required
    await seedPayable(PAYABLE_ID, 500, 500, 0, 'paid');

    await expect(
      returnLot(db as never, {
        organizationId: ORG,
        lotId: LOT_ID,
        qtyReturned: 2,
        refundContainerId: undefined,
        createdBy: 'user-sr15',
      }),
    ).rejects.toThrow('refund_container_required');

    // No writes (clean rollback)
    const refunds = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM supplier_refunds`,
      [],
    );

    expect(Number(refunds.rows[0]!.count)).toBe(0);

    const tmRows = await pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM treasury_movements`,
      [],
    );

    expect(Number(tmRows.rows[0]!.count)).toBe(0);
  });
});

// ── SR-16: supplier_refunds in TENANT_TABLES proxy regression ─────────────────

describe('supplier_refunds — SR-16: TenantDb proxy — supplier_refunds must be registered', () => {
  it('succeeds via the TenantDb proxy (supplier_refunds is in TENANT_TABLES)', async () => {
    const tdb = createTenantDb(db as never, ORG);

    await seedProduct(PRODUCT_ID, 10);
    await seedLot(LOT_ID, 10, 5, '100.00');
    await seedContainer();
    await seedPayable(PAYABLE_ID, 500, 500, 0, 'paid');

    // Should NOT throw "Table 'supplier_refunds' is not registered as a tenant table"
    await expect(
      returnLot(tdb as never, {
        organizationId: ORG,
        lotId: LOT_ID,
        qtyReturned: 1,
        refundContainerId: CONTAINER_ID,
        createdBy: 'user-sr16',
      }),
    ).resolves.toBeDefined();

    // Verify the refund was written
    const refunds = await pg.query<{ amount: string }>(
      `SELECT amount FROM supplier_refunds WHERE organization_id = $1`,
      [ORG],
    );

    expect(refunds.rows).toHaveLength(1);
    expect(Number(refunds.rows[0]!.amount)).toBeCloseTo(100, 2);
  });

  it('fails with a clear TENANT_TABLES error when supplier_refunds is NOT registered', () => {
    const tdb = createTenantDb(db as never, ORG);
    const fakeTable = { organizationId: {} } as never;

    expect(() => {
      tdb.insert(fakeTable);
    }).toThrow(/not registered as a tenant table/);
  });
});

// ── SR-17: treasury_mov_one_external CHECK constraint ─────────────────────────
// Proves the highest-risk migration change: the rewritten CHECK now permits
// one-sided 'refund' rows (from=null, to=container) and still rejects one-sided
// 'transfer' rows (which must always have both sides).

describe('treasury_movements CHECK — SR-17: one-sided refund OK, one-sided transfer rejected', () => {
  it('INSERTs a one-sided refund row (to=container, from=null) without error', async () => {
    await seedContainer();

    await expect(
      pg.query(
        `INSERT INTO treasury_movements
           (organization_id, from_account_id, to_account_id, amount, type, created_by)
         VALUES ($1, NULL, $2, '100.00', 'refund', 'user-sr17a')`,
        [ORG, CONTAINER_ID],
      ),
    ).resolves.toBeDefined();

    const rows = await pg.query<{ type: string; from_account_id: string | null }>(
      `SELECT type, from_account_id FROM treasury_movements WHERE organization_id = $1`,
      [ORG],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.type).toBe('refund');
    expect(rows.rows[0]!.from_account_id).toBeNull();
  });

  it('REJECTs a one-sided transfer row (from=null, to=container) with a CHECK violation', async () => {
    await seedContainer();

    await expect(
      pg.query(
        `INSERT INTO treasury_movements
           (organization_id, from_account_id, to_account_id, amount, type, created_by)
         VALUES ($1, NULL, $2, '100.00', 'transfer', 'user-sr17b')`,
        [ORG, CONTAINER_ID],
      ),
    ).rejects.toThrow(/treasury_mov_one_external|check.*constraint|violates/i);
  });
});
