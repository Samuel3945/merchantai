/**
 * POST /api/pos/sales — idempotency contract (TDD: RED → GREEN)
 *
 * Verifies exactly-once sale capture via sale_idempotency_key:
 *   1. Duplicate submit with same key → 200 deduped, exactly ONE row in sales.
 *   2. Deduped retry does NOT double-decrement stock / emit a second FIFO exit.
 *   3. Fresh key → 201 normal creation.
 *   4. No key → 201 back-compat (null stored).
 *
 * PGLite DDL includes sale_idempotency_key and the partial unique index to
 * mirror the production schema exactly (ref: drizzle_pglite_test_ddl_gotcha).
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
  resolvePosActor: vi.fn(() => 'test-actor'),
}));
// recordCashMovement is called after the TX — mock it to avoid needing
// a full cash_movements DDL in this focused test.
vi.mock('@/libs/cash-helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/libs/cash-helpers')>();
  return {
    ...original,
    recordCashMovement: vi.fn(async () => {}),
    findOpenSession: vi.fn(async () => ({ id: 'session-stub' })),
  };
});
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
const ORG = 'org_idempotency_test';
const TOKEN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const IDEMPOTENCY_KEY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------
// PGLite schema — mirrors production columns exactly (42703 guard)
// Includes sale_idempotency_key + the partial unique index.
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TYPE "sale_status" AS ENUM('completed','voided','returned');
  CREATE TYPE "sale_channel" AS ENUM('pos','panel','delivery','agent');

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
    channel "sale_channel" DEFAULT 'pos' NOT NULL,
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
    size jsonb,
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

  CREATE TABLE org_sale_counters (
    organization_id text PRIMARY KEY NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  -- Seed the org counter so assignNextSaleNumber works.
  INSERT INTO org_sale_counters (organization_id, last_number) VALUES ('${ORG}', 0);
`;

let pg: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePosRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedProduct(
  stock: number = 10,
  id: string = PRODUCT_ID,
): Promise<void> {
  await pg.query(
    `INSERT INTO products
       (id, organization_id, name, price, cost, stock, status, deleted, attributes)
     VALUES ($1, $2, 'Widget', '5.00', '2.00', $3, 'published', false, '{}')`,
    [id, ORG, stock],
  );
}

async function stockMovementCount(productId: string): Promise<number> {
  const result = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM stock_movements WHERE product_id = $1`,
    [productId],
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

async function currentStock(productId: string): Promise<number> {
  const result = await pg.query<{ stock: number }>(
    `SELECT stock FROM products WHERE id = $1`,
    [productId],
  );
  return result.rows[0]?.stock ?? 0;
}

async function salesCount(org: string): Promise<number> {
  const result = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sales WHERE organization_id = $1`,
    [org],
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM stock_movements; DELETE FROM sale_payments; DELETE FROM sale_items; DELETE FROM sales; DELETE FROM products;',
  );
  await pg.exec(
    `UPDATE org_sale_counters SET last_number = 0 WHERE organization_id = '${ORG}'`,
  );
  h.authCtx = {
    organizationId: ORG,
    cashierName: 'Tester',
    source: 'token',
    tokenId: TOKEN_ID,
    cashierId: null,
    canConfirmTransfers: false,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/pos/sales — idempotency', () => {
  it('P1.3 — fresh key creates a sale (201)', async () => {
    await seedProduct();

    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.id).toBeDefined();
    expect(body.deduped).toBeUndefined();

    expect(await salesCount(ORG)).toBe(1);
  });

  it('P1.3 — duplicate key returns 200 deduped, exactly ONE row in sales', async () => {
    await seedProduct();

    // First submit
    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const firstBody = await first.json();

    // Second submit with same key
    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);

    const secondBody = await second.json();

    // Same row returned
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.deduped).toBe(true);

    // Only one sale row was ever created
    expect(await salesCount(ORG)).toBe(1);
  });

  it('P1.3 — deduped retry does NOT double-decrement stock (FIFO invariant)', async () => {
    await seedProduct(10);

    // First POST: consumes 2 units, creates 1 stock_movement exit row
    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const stockAfterFirst = await currentStock(PRODUCT_ID);
    const movementsAfterFirst = await stockMovementCount(PRODUCT_ID);

    // Second POST with same key: must not touch stock at all
    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);
    expect((await second.json()).deduped).toBe(true);

    // Stock did NOT change after the deduped retry
    expect(await currentStock(PRODUCT_ID)).toBe(stockAfterFirst);
    // No new stock_movements row was inserted
    expect(await stockMovementCount(PRODUCT_ID)).toBe(movementsAfterFirst);
  });

  it('P1.3 — no key creates sale normally, null stored (back-compat)', async () => {
    await seedProduct();

    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        // no sale_idempotency_key
      }),
    );

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.id).toBeDefined();
    expect(body.deduped).toBeUndefined();

    // Verify the DB row has null for the key
    const row = await pg.query<{ sale_idempotency_key: string | null }>(
      `SELECT sale_idempotency_key FROM sales WHERE id = $1`,
      [body.id],
    );

    expect(row.rows[0]?.sale_idempotency_key).toBeNull();
  });

  it('P1.1 — malformed (non-UUID) key creates sale normally, no crash, null stored', async () => {
    await seedProduct();

    // A non-UUID key must NOT reach the uuid column (Postgres 22P02). The route
    // treats it as null: normal create, no dedupe, no 500.
    const res = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        sale_idempotency_key: 'not-a-uuid',
      }),
    );

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.id).toBeDefined();
    expect(body.deduped).toBeUndefined();

    const row = await pg.query<{ sale_idempotency_key: string | null }>(
      `SELECT sale_idempotency_key FROM sales WHERE id = $1`,
      [body.id],
    );

    expect(row.rows[0]?.sale_idempotency_key).toBeNull();
    expect(await salesCount(ORG)).toBe(1);
  });

  it('P1.3 — deduped response includes items + payments (shape parity)', async () => {
    await seedProduct();

    const first = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );
    const firstBody = await first.json();

    const second = await POST(
      makePosRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        sale_idempotency_key: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);

    const secondBody = await second.json();

    expect(secondBody.deduped).toBe(true);
    expect(secondBody.id).toBe(firstBody.id);
    expect(Array.isArray(secondBody.items)).toBe(true);
    expect(secondBody.items).toHaveLength(1);
    expect(Array.isArray(secondBody.payments)).toBe(true);
    expect(secondBody.payments.length).toBeGreaterThanOrEqual(1);
  });
});
