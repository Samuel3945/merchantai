/**
 * POST /api/agent/orders
 *
 * Exercises the n8n agent order endpoint against real PGlite tables (not
 * mocked queries), so the actual SQL — createSaleForOrg's transaction, the
 * caja lookup, the product/customer ownership checks — runs for real. Only
 * requireAgentAuth (identity) and the post-commit best-effort side effects
 * (recordCashMovement, transfer reconciliation, invoice emission, audit log)
 * are mocked, mirroring the convention in
 * src/app/api/agent/products/route.test.ts and
 * src/app/api/pos/sales/sales.idempotency.test.ts.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG = 'org_agent_orders_test';
const OTHER_ORG = 'org_agent_orders_other_test';
// zod's `.uuid()` enforces RFC4122 version/variant nibbles (3rd group starts
// 1-5, 4th group starts 8/9/a/b) — plain repeated-hex fakes like
// 'bbbbbbbb-bbbb-bbbb-...' fail that check even though Postgres itself
// accepts any 8-4-4-4-12 hex string. Every id that flows through the route's
// zod schema below must be version/variant-compliant.
const CHANNEL_ID = '88888888-8888-4888-8888-888888888888';
const AGENT_TOKEN_ID = '99999999-9999-4999-8999-999999999999';
const TOKEN_ID = '77777777-7777-4777-8777-777777777777';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG_CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const IDEMPOTENCY_KEY = '55555555-5555-4555-8555-555555555555';
const UNKNOWN_PRODUCT_ID = '66666666-6666-4666-8666-666666666666';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  capabilities: { orders: true } as Record<string, boolean>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/agent-auth', () => ({
  requireAgentAuth: vi.fn(async () => ({
    ctx: {
      organizationId: ORG,
      channelId: CHANNEL_ID,
      capabilities: h.capabilities,
      tokenId: AGENT_TOKEN_ID,
    },
    errorResponse: null,
  })),
}));

// createSaleForOrg (src/actions/sales.ts) pulls in Clerk + next/cache at
// module scope even though this path never calls createSale() — stub both so
// importing the shared core doesn't require a real Clerk/Next request context.
vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: null, orgId: null })),
  clerkClient: vi.fn(async () => ({
    users: { getUserList: vi.fn(async () => ({ data: [] })) },
  })),
  currentUser: vi.fn(async () => null),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('@/libs/cash-helpers', () => ({
  recordCashMovement: vi.fn(async () => null),
}));

vi.mock('@/libs/einvoice/emit', () => ({
  maybeAutoEmitInvoice: vi.fn(async () => {}),
  maybeEmitCreditNote: vi.fn(async () => {}),
}));

vi.mock('@/libs/transfer-reconciliation', () => ({
  recordSaleTransferReconciliations: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// PGLite schema — mirrors production columns exactly (drizzle_pglite_test_ddl_gotcha).
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TYPE "sale_status" AS ENUM('completed','voided','returned');
  CREATE TYPE "cash_session_status" AS ENUM('open','closed');

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

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    opened_by text NOT NULL,
    opening_amount numeric(12, 2) DEFAULT '0' NOT NULL,
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
    opened_at timestamp DEFAULT now() NOT NULL,
    closed_at timestamp,
    client_session_id uuid
  );

  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    deleted boolean DEFAULT false NOT NULL
  );

  CREATE TABLE org_sale_counters (
    organization_id text PRIMARY KEY NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  INSERT INTO org_sale_counters (organization_id, last_number) VALUES ('${ORG}', 0);
  INSERT INTO org_sale_counters (organization_id, last_number) VALUES ('${OTHER_ORG}', 0);
`;

let pg: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

async function seedProduct(
  id: string,
  org: string,
  opts: { stock?: number; status?: string; deleted?: boolean } = {},
): Promise<void> {
  const { stock = 10, status = 'published', deleted = false } = opts;
  await pg.query(
    `INSERT INTO products
       (id, organization_id, name, price, cost, stock, status, deleted, attributes)
     VALUES ($1, $2, 'Widget', '5.00', '2.00', $3, $4, $5, '{}')`,
    [id, org, stock, status, deleted],
  );
}

async function seedCustomer(id: string, org: string): Promise<void> {
  await pg.query(
    `INSERT INTO customers (id, organization_id, name, deleted) VALUES ($1, $2, 'Cliente Test', false)`,
    [id, org],
  );
}

async function openSession(org: string, posTokenId: string | null = TOKEN_ID): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO cash_sessions (organization_id, pos_token_id, opened_by, opening_amount, status)
     VALUES ($1, $2, 'opener', '0', 'open') RETURNING id`,
    [org, posTokenId],
  );
  return r.rows[0]!.id;
}

async function salesCount(org: string = ORG): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sales WHERE organization_id = $1`,
    [org],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function stockMovementCount(productId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM stock_movements WHERE product_id = $1`,
    [productId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function currentStock(productId: string): Promise<number> {
  const r = await pg.query<{ stock: string | number }>(
    `SELECT stock FROM products WHERE id = $1`,
    [productId],
  );
  return Number(r.rows[0]?.stock ?? 0);
}

async function saleItemsCount(saleId: string): Promise<number> {
  const r = await pg.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM sale_items WHERE sale_id = $1`,
    [saleId],
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function salePaymentRow(saleId: string): Promise<{ method: string; amount: string } | undefined> {
  const r = await pg.query<{ method: string; amount: string }>(
    `SELECT method, amount FROM sale_payments WHERE sale_id = $1 LIMIT 1`,
    [saleId],
  );
  return r.rows[0];
}

async function saleRow(saleId: string): Promise<{ pos_token_id: string | null; total: string } | undefined> {
  const r = await pg.query<{ pos_token_id: string | null; total: string }>(
    `SELECT pos_token_id, total FROM sales WHERE id = $1`,
    [saleId],
  );
  return r.rows[0];
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
    'DELETE FROM stock_movements; DELETE FROM sale_payments; DELETE FROM sale_items; '
    + 'DELETE FROM sales; DELETE FROM cash_sessions; DELETE FROM customers; DELETE FROM products;',
  );
  await pg.exec(
    `UPDATE org_sale_counters SET last_number = 0 WHERE organization_id IN ('${ORG}', '${OTHER_ORG}')`,
  );
  h.capabilities = { orders: true };
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/agent/orders', () => {
  it('no open caja → 409 no_open_caja, no sale/stock_movement created', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.error).toBe('no_open_caja');

    expect(await salesCount()).toBe(0);
    expect(await stockMovementCount(PRODUCT_ID)).toBe(0);
  });

  it('open caja + valid items → 201, sale/items/payment/stock correct', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });
    const sessionId = await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(201);

    const body = await res.json();

    expect(body.id).toBeDefined();
    expect(body.total).toBe('10.00');
    expect(body.caja.sessionId).toBe(sessionId);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      productId: PRODUCT_ID,
      qty: 2,
      unitPrice: '5.00',
      lineTotal: '10.00',
    });

    const sale = await saleRow(body.id);

    expect(sale?.pos_token_id).toBe(TOKEN_ID);
    expect(sale?.total).toBe('10.00');

    expect(await saleItemsCount(body.id)).toBe(1);

    const payment = await salePaymentRow(body.id);

    expect(payment?.method).toBe('Contraentrega');
    expect(payment?.amount).toBe('10.00');

    expect(await currentStock(PRODUCT_ID)).toBe(8);
    expect(await stockMovementCount(PRODUCT_ID)).toBe(1);
  });

  it('oversell (qty > stock) → 422, nothing created', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 3 });
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 5 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.error).toBe('insufficient_stock');

    expect(await salesCount()).toBe(0);
    expect(await stockMovementCount(PRODUCT_ID)).toBe(0);
    expect(await currentStock(PRODUCT_ID)).toBe(3);
  });

  it('archived product → 422 product_not_found', async () => {
    await seedProduct(PRODUCT_ID, ORG, { status: 'archived' });
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('product_not_found');
    expect(await salesCount()).toBe(0);
  });

  it('deleted product → 422 product_not_found', async () => {
    await seedProduct(PRODUCT_ID, ORG, { deleted: true });
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('product_not_found');
    expect(await salesCount()).toBe(0);
  });

  it('unknown productId → 422 product_not_found', async () => {
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: UNKNOWN_PRODUCT_ID, qty: 1 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('product_not_found');
    expect(await salesCount()).toBe(0);
  });

  it('capabilities.orders=false → 403, no DB rows created', async () => {
    h.capabilities = { products_lookup: true };
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(403);
    expect(await salesCount()).toBe(0);
    expect(await currentStock(PRODUCT_ID)).toBe(10);
  });

  it('credito paymentMethod → 422, no caja required check reached', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        paymentMethod: 'Crédito',
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('credito_not_allowed');
    expect(await salesCount()).toBe(0);
  });

  it('idempotency: same key submitted twice → second call returns the SAME sale id, stock decremented once', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });
    await openSession(ORG, TOKEN_ID);

    const first = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(first.status).toBe(201);

    const firstBody = await first.json();

    const second = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 2 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(second.status).toBe(200);

    const secondBody = await second.json();

    expect(secondBody.id).toBe(firstBody.id);
    expect(await salesCount()).toBe(1);
    expect(await currentStock(PRODUCT_ID)).toBe(8);
    expect(await stockMovementCount(PRODUCT_ID)).toBe(1);
  });

  it('cross-org product → 422, never leaks the other org\'s product', async () => {
    await seedProduct(OTHER_ORG_PRODUCT_ID, OTHER_ORG, { stock: 10 });
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: OTHER_ORG_PRODUCT_ID, qty: 1 }],
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.error).toBe('product_not_found');
    expect(JSON.stringify(body)).not.toMatch(/price|stock/i);
    expect(await salesCount()).toBe(0);
  });

  it('cross-org customerId → 422, never leaks the other org\'s customer', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });
    await seedCustomer(OTHER_ORG_CUSTOMER_ID, OTHER_ORG);
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        customerId: OTHER_ORG_CUSTOMER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('customer_not_found');
    expect(await salesCount()).toBe(0);
  });

  it('valid customerId in-org → 201', async () => {
    await seedProduct(PRODUCT_ID, ORG, { stock: 10 });
    await seedCustomer(CUSTOMER_ID, ORG);
    await openSession(ORG, TOKEN_ID);

    const res = await POST(
      makeRequest({
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        customerId: CUSTOMER_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );

    expect(res.status).toBe(201);
  });
});
