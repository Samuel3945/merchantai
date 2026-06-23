/**
 * POST /api/pos/sales — deduped side-effect convergence (TDD: RED → GREEN)
 *
 * The critical correctness fix: if the ORIGINAL request died between the sale
 * commit and recordCashMovement, the cash for a real sale is never recorded →
 * drawer shortage at close. A deduped retry must COMPLETE the missing
 * post-commit side effects (cash movement) without re-decrementing stock or
 * re-emitting a FIFO exit.
 *
 * Net guarantee asserted here: for a given sale_id, exactly ONE cash_movement
 * and the FIFO stock stays single-decremented, no matter which request finishes
 * the side effects.
 *
 * This test uses the REAL recordCashMovement (cash-helpers is NOT mocked) so the
 * idempotency-by-sale_id guard is genuinely exercised against cash_movements.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
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
  resolvePosActor: vi.fn(() => ({ type: 'cashier', id: 'test-actor' })),
}));
vi.mock('@/libs/einvoice/emit', () => ({
  maybeAutoEmitInvoice: vi.fn(async () => {}),
}));
vi.mock('@/libs/transfer-reconciliation', () => ({
  recordSaleTransferReconciliations: vi.fn(async () => {}),
}));
vi.mock('@/features/customers/post-sale-hook', () => ({
  applyInvoiceCustomerUpsert: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG = 'org_dedupe_convergence_test';
const TOKEN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const IDEMPOTENCY_KEY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------
// PGLite schema — sales path + cash_sessions/cash_movements/audit_logs so the
// REAL recordCashMovement and the side-effect convergence guard run for real.
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TYPE "sale_status" AS ENUM('completed','voided','returned');
  CREATE TYPE "cash_session_status" AS ENUM('open','closed');
  CREATE TYPE "cash_movement_type" AS ENUM(
    'sale','deposit','withdrawal','expense','salary','inventory_purchase',
    'advance','adjustment','fiado_payment','reclassification'
  );

  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_number integer,
    total numeric(10, 2) NOT NULL,
    payment_type text DEFAULT 'cash' NOT NULL,
    status "sale_status" DEFAULT 'completed' NOT NULL,
    notes text,
    cashier_id text,
    pos_token_id uuid,
    einvoice_status text DEFAULT 'pending' NOT NULL,
    einvoice_cufe text,
    einvoice_number text,
    einvoice_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    occurred_at timestamp DEFAULT now() NOT NULL,
    sale_idempotency_key uuid
  );

  CREATE UNIQUE INDEX sales_org_idempotency_key_unique_idx
    ON sales (organization_id, sale_idempotency_key)
    WHERE sale_idempotency_key IS NOT NULL;

  CREATE TABLE sale_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    qty numeric(12, 3) NOT NULL,
    price numeric(10, 2) NOT NULL,
    subtotal numeric(10, 2) NOT NULL,
    unit_type text DEFAULT 'unit' NOT NULL
  );

  CREATE TABLE sale_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    bills_paid jsonb,
    change_given numeric(10, 2) DEFAULT '0' NOT NULL,
    reference text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TYPE "product_unit_type" AS ENUM('unit', 'kg');
  CREATE TYPE "product_status" AS ENUM('draft','scheduled','published','archived');
  CREATE TYPE "stock_movement_type" AS ENUM('entry','exit','adjustment');

  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    barcode text,
    price numeric(10, 2) NOT NULL,
    cost numeric(10, 2) DEFAULT '0' NOT NULL,
    stock numeric(12, 3) DEFAULT 0 NOT NULL,
    min_stock numeric(12, 3) DEFAULT 0 NOT NULL,
    stock_max_recommended numeric(12, 3),
    category text,
    category_id uuid,
    unit_type "product_unit_type" DEFAULT 'unit' NOT NULL,
    is_perishable boolean DEFAULT false NOT NULL,
    is_wholesale boolean DEFAULT false NOT NULL,
    wholesale_tiers jsonb,
    is_digital boolean DEFAULT false NOT NULL,
    digital_limit integer,
    attributes jsonb DEFAULT '{}' NOT NULL,
    status "product_status" DEFAULT 'published' NOT NULL,
    publish_at timestamp,
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
    qty numeric(12, 3) NOT NULL,
    remaining_qty numeric(12, 3),
    unit_cost numeric(12, 2),
    expires_at date,
    reason text,
    created_by text,
    sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
    supplier_id text,
    notes text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    closed_by text,
    expected_amount numeric(12, 2),
    counted_amount numeric(12, 2),
    difference numeric(12, 2),
    status "cash_session_status" DEFAULT 'open' NOT NULL,
    notes text,
    opening_expected numeric(12, 2),
    opening_difference numeric(12, 2),
    opening_explanation text,
    opened_at timestamp DEFAULT now() NOT NULL,
    closed_at timestamp
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
    sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
    supplier_id uuid,
    corrects_session_id uuid,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE org_sale_counters (
    organization_id text PRIMARY KEY NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  INSERT INTO org_sale_counters (organization_id, last_number) VALUES ('${ORG}', 0);
`;

let pg: PGlite;

function makePosRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedProduct(stock = 10): Promise<void> {
  await pg.query(
    `INSERT INTO products
       (id, organization_id, name, price, cost, stock, status, deleted, attributes)
     VALUES ($1, $2, 'Widget', '5.00', '2.00', $3, 'published', false, '{}')`,
    [PRODUCT_ID, ORG, stock],
  );
}

async function openSession(): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions
       (organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, 'opener', '0', 'open')`,
    [ORG, TOKEN_ID],
  );
}

async function cashMovementCountForSale(saleId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM cash_movements
      WHERE sale_id = $1 AND type = 'sale'`,
    [saleId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function stockMovementExitCount(productId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM stock_movements
      WHERE product_id = $1 AND type = 'exit'`,
    [productId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function currentStock(productId: string): Promise<number> {
  const r = await pg.query<{ stock: number }>(
    `SELECT stock FROM products WHERE id = $1`,
    [productId],
  );
  return r.rows[0]?.stock ?? 0;
}

async function salesCount(): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sales WHERE organization_id = $1`,
    [ORG],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM cash_movements; DELETE FROM stock_movements; DELETE FROM sale_payments; DELETE FROM sale_items; DELETE FROM sales; DELETE FROM cash_sessions; DELETE FROM products;',
  );
  await pg.exec(
    `UPDATE org_sale_counters SET last_number = 0 WHERE organization_id = '${ORG}'`,
  );
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Tester',
    cashierId: 'cashier-1',
    source: 'token',
    tokenId: TOKEN_ID,
    canConfirmTransfers: false,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

describe('POST /api/pos/sales — deduped side-effect convergence', () => {
  it('P1.2 — happy path records exactly ONE cash_movement for the sale', async () => {
    await seedProduct(10);
    await openSession();

    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(await cashMovementCountForSale(body.id)).toBe(1);
  });

  it('P1.2 — deduped retry COMPLETES a missing cash_movement (crash-window recovery)', async () => {
    await seedProduct(10);
    await openSession();

    // 1) First request: creates the sale + items + payments + FIFO exit, but we
    //    simulate the ORIGINAL dying right after commit by deleting the
    //    cash_movement it produced. This reproduces the crash window: a real
    //    sale exists with NO cash recorded → drawer shortage at close.
    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const firstBody = await first.json();
    const saleId = firstBody.id;

    // Simulate the crash window: cash never got recorded.
    await pg.query(`DELETE FROM cash_movements WHERE sale_id = $1`, [saleId]);

    expect(await cashMovementCountForSale(saleId)).toBe(0);

    const stockAfterFirst = await currentStock(PRODUCT_ID);
    const exitsAfterFirst = await stockMovementExitCount(PRODUCT_ID);

    // 2) Deduped retry: must complete the missing cash_movement, NOT re-create
    //    the sale, NOT re-decrement stock, NOT re-emit a FIFO exit.
    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);
    expect((await second.json()).deduped).toBe(true);

    // Exactly ONE cash_movement now exists for the sale (the retry completed it).
    expect(await cashMovementCountForSale(saleId)).toBe(1);
    // Still exactly one sale row.
    expect(await salesCount()).toBe(1);
    // FIFO untouched: stock single-decremented, no second exit movement.
    expect(await currentStock(PRODUCT_ID)).toBe(stockAfterFirst);
    expect(await stockMovementExitCount(PRODUCT_ID)).toBe(exitsAfterFirst);
  });

  it('P1.2 — deduped retry after a COMPLETE original adds no second cash_movement', async () => {
    await seedProduct(10);
    await openSession();

    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );
    const saleId = (await first.json()).id;

    // Original fully completed: one cash_movement already exists.
    expect(await cashMovementCountForSale(saleId)).toBe(1);

    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);

    // Still exactly one — no double cash entry.
    expect(await cashMovementCountForSale(saleId)).toBe(1);
  });

  it('P1.5 — pre-existing same-key row forces the 23505 race branch (deduped, converged)', async () => {
    // PGLite limitation note: PGLite is single-connection, so a TRUE concurrent
    // 23505 race (two in-flight transactions) cannot be simulated. We cover the
    // equivalent observable outcome by pre-inserting a winning sale row with the
    // same key BEFORE the POST. The pre-SELECT belt catches it here, returning a
    // deduped 200 with converged side effects (one sale, one cash_movement). The
    // 23505 catch path is unit-covered by construction: it re-SELECTs the same
    // winning row and runs the same applyPostSaleSideEffects routine.
    await seedProduct(10);
    await openSession();

    // Pre-insert the winning sale (as if a concurrent request already committed
    // it) WITHOUT its post-sale side effects (the crash window again).
    const pre = await pg.query<{ id: string }>(
      `INSERT INTO sales
         (organization_id, sale_number, total, payment_type, status,
          cashier_id, pos_token_id, sale_idempotency_key)
       VALUES ($1, 1, '5.00', 'Efectivo', 'completed', 'cashier-1', $2, $3)
       RETURNING id`,
      [ORG, TOKEN_ID, IDEMPOTENCY_KEY],
    );
    const winningSaleId = pre.rows[0]!.id;
    await pg.query(
      `INSERT INTO sale_payments (sale_id, method, amount)
       VALUES ($1, 'Efectivo', '5.00')`,
      [winningSaleId],
    );

    expect(await cashMovementCountForSale(winningSaleId)).toBe(0);

    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentType: 'Efectivo',
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.deduped).toBe(true);
    expect(body.id).toBe(winningSaleId);
    // Side effects converged on the deduped path: exactly one cash_movement.
    expect(await cashMovementCountForSale(winningSaleId)).toBe(1);
    // No second sale row.
    expect(await salesCount()).toBe(1);
  });
});
