/**
 * POST /api/pos/sync (batch) — idempotency contract (TDD: RED → GREEN)
 *
 * Verifies that the legacy batch sync path dedupes by sale_idempotency_key:
 *   1. Two batch POST rows sharing the same key → exactly 1 sales row created.
 *   2. Existing tests (normal batch creation) still pass.
 *
 * PGLite DDL includes sale_idempotency_key on the sales table.
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
  posToken: null as Record<string, unknown> | null,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));
vi.mock('@/actions/pos-tokens', () => ({
  validatePosToken: vi.fn(async () => h.posToken),
  touchLastSync: vi.fn(async () => {}),
}));
vi.mock('@/libs/audit-log', async importOriginal => ({
  ...(await importOriginal<typeof import('@/libs/audit-log')>()),
  logAction: vi.fn(async () => {}),
  resolvePosActor: vi.fn(() => 'test-actor'),
}));
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
const ORG = 'org_sync_idempotency_test';
const TOKEN = 'sync-test-token';
const TOKEN_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const PRODUCT_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const IDEMPOTENCY_KEY = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

// ---------------------------------------------------------------------------
// PGLite schema — mirrors production + includes sale_idempotency_key
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TYPE "sale_status" AS ENUM('completed','voided','returned');

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

  CREATE TABLE org_sale_counters (
    organization_id text PRIMARY KEY NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  INSERT INTO org_sale_counters (organization_id, last_number) VALUES ('${ORG}', 0);
`;

let pg: PGlite;

function makeSyncRequest(body: unknown): Request {
  return new Request('http://localhost/api/pos/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedProduct(stock = 10): Promise<void> {
  await pg.query(
    `INSERT INTO products
       (id, organization_id, name, price, cost, stock, status, deleted, attributes)
     VALUES ($1, $2, 'Sync Widget', '3.00', '1.00', $3, 'published', false, '{}')`,
    [PRODUCT_ID, ORG, stock],
  );
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
    'DELETE FROM stock_movements; DELETE FROM sale_payments; DELETE FROM sale_items; DELETE FROM sales; DELETE FROM products;',
  );
  await pg.exec(
    `UPDATE org_sale_counters SET last_number = 0 WHERE organization_id = '${ORG}'`,
  );
  h.posToken = {
    id: TOKEN_ID,
    organizationId: ORG,
    cashierId: null,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

describe('POST /api/pos/sync — idempotency', () => {
  it('P1.4 — two batch rows with same sale_idempotency_key yield exactly 1 sales row', async () => {
    await seedProduct(10);

    // First batch: two sales, both carrying the SAME idempotency key
    const res = await POST(
      makeSyncRequest({
        token: TOKEN,
        sales: [
          {
            localId: 1,
            items: [{ productId: PRODUCT_ID, qty: 1 }],
            paymentType: 'Efectivo',
            sale_idempotency_key: IDEMPOTENCY_KEY,
          },
          {
            localId: 2,
            items: [{ productId: PRODUCT_ID, qty: 1 }],
            paymentType: 'Efectivo',
            sale_idempotency_key: IDEMPOTENCY_KEY,
          },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    // First item: success (creates the sale)
    expect(body.results[0].success).toBe(true);
    expect(body.results[0].serverSaleId).toBeDefined();

    // Second item: also success (deduped, returns same sale)
    expect(body.results[1].success).toBe(true);
    // Both should reference the same server sale id
    expect(body.results[1].serverSaleId).toBe(body.results[0].serverSaleId);

    // Only ONE row in the sales table
    expect(await salesCount()).toBe(1);
  });

  it('P1.4 — normal batch with different keys creates multiple sales', async () => {
    await seedProduct(10);

    const KEY_A = '11111111-1111-1111-1111-111111111111';
    const KEY_B = '22222222-2222-2222-2222-222222222222';

    const res = await POST(
      makeSyncRequest({
        token: TOKEN,
        sales: [
          {
            localId: 1,
            items: [{ productId: PRODUCT_ID, qty: 1 }],
            paymentType: 'Efectivo',
            sale_idempotency_key: KEY_A,
          },
          {
            localId: 2,
            items: [{ productId: PRODUCT_ID, qty: 1 }],
            paymentType: 'Efectivo',
            sale_idempotency_key: KEY_B,
          },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.results[0].success).toBe(true);
    expect(body.results[1].success).toBe(true);
    // Two distinct sales
    expect(body.results[0].serverSaleId).not.toBe(body.results[1].serverSaleId);
    expect(await salesCount()).toBe(2);
  });

  it('P1.4 — no key in batch still works (back-compat)', async () => {
    await seedProduct(10);

    const res = await POST(
      makeSyncRequest({
        token: TOKEN,
        sales: [
          {
            localId: 1,
            items: [{ productId: PRODUCT_ID, qty: 1 }],
            paymentType: 'Efectivo',
            // no sale_idempotency_key
          },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.results[0].success).toBe(true);
    expect(await salesCount()).toBe(1);
  });
});
