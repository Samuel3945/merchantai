/**
 * POST /api/agent/deliveries/quote
 *
 * Lets the WhatsApp agent quote a delivery BEFORE the customer confirms.
 * Scenarios covered:
 *   1. capabilities.orders=false → 403
 *   2. product missing/deleted → 422 product_not_found
 *   3. insufficient stock → 422 insufficient_stock
 *   4. unknown key ("price") in item → 400 (strict schema)
 *   5. type 'none' (unconfigured) → shipping 0
 *   6. type 'fixed' → shipping is the configured amount
 *   7. type 'percent' → shipping is the rounded percentage of subtotal
 *   8. free-above threshold zeroes shipping when reached
 *   9. duplicate productIds aggregated into one line, summed qty
 *  10. duplicate productIds summed qty exceeds stock → 422 insufficient_stock
 *  11. multiple distinct products → subtotal sums all line totals
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_deliveries_quote_test';
const PRODUCT_A_ID = 'aaaaaaaa-0001-4001-8001-000000000001';
const PRODUCT_B_ID = 'aaaaaaaa-0002-4002-8002-000000000002';
const PRODUCT_LOW_STOCK_ID = 'aaaaaaaa-0003-4003-8003-000000000003';

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
      channelId: 'eeeeeeee-0001-0001-0001-ffffffffffff',
      capabilities: h.capabilities,
      tokenId: 'eeeeeeee-0002-0002-0002-ffffffffffff',
    },
    errorResponse: null,
  })),
}));

const SCHEMA = `
  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );

  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    price numeric(10, 2) NOT NULL,
    stock numeric(12, 3) DEFAULT 0 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

async function setSetting(key: string, value: string): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $3`,
    [ORG, key, value],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);

  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Arroz 500g', '3500.00', 10)`,
    [PRODUCT_A_ID, ORG],
  );
  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Leche 1L', '4000.00', 10)`,
    [PRODUCT_B_ID, ORG],
  );
  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Producto Agotado', '2000.00', 0)`,
    [PRODUCT_LOW_STOCK_ID, ORG],
  );
});

beforeEach(async () => {
  h.capabilities = { orders: true };
  await pg.exec('DELETE FROM app_settings;');
});

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/deliveries/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/agent/deliveries/quote', () => {
  it('capabilities.orders=false → 403', async () => {
    h.capabilities = { products_lookup: true }; // no orders
    const { POST } = await import('./route');
    const res = await POST(postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 1 }] }));

    expect(res.status).toBe(403);
  });

  it('product missing/deleted → 422 product_not_found', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ items: [{ productId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', qty: 1 }] }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('product_not_found');
  });

  it('insufficient stock → 422 insufficient_stock', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ items: [{ productId: PRODUCT_LOW_STOCK_ID, qty: 5 }] }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('insufficient_stock');
  });

  it('item body carrying unknown key "price" → 400 (strict schema rejects it)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 1, price: 999 }] }),
    );

    expect(res.status).toBe(400);
  });

  it('no delivery fee configured (type none) → shipping 0, total = subtotal', async () => {
    const { POST } = await import('./route');
    const res = await POST(postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 2 }] }));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.subtotal).toBe(7000);
    expect(body.shipping).toBe(0);
    expect(body.total).toBe(7000);
    expect(body.items).toEqual([
      { productId: PRODUCT_A_ID, name: 'Arroz 500g', qty: 2, price: 3500, lineTotal: 7000 },
    ]);
  });

  it('type \'fixed\' → shipping is the configured fixed amount', async () => {
    await setSetting('delivery_fee_type', 'fixed');
    await setSetting('delivery_fee_value', '5000');

    const { POST } = await import('./route');
    const res = await POST(postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 1 }] }));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.subtotal).toBe(3500);
    expect(body.shipping).toBe(5000);
    expect(body.total).toBe(8500);
  });

  it('type \'percent\' → shipping is the rounded percentage of subtotal', async () => {
    await setSetting('delivery_fee_type', 'percent');
    await setSetting('delivery_fee_value', '10');

    const { POST } = await import('./route');
    const res = await POST(postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 1 }] })); // subtotal 3500

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.subtotal).toBe(3500);
    expect(body.shipping).toBe(350);
    expect(body.total).toBe(3850);
  });

  it('free-above threshold zeroes shipping when subtotal reaches it', async () => {
    await setSetting('delivery_fee_type', 'fixed');
    await setSetting('delivery_fee_value', '5000');
    await setSetting('delivery_free_above', '7000');

    const { POST } = await import('./route');
    const res = await POST(postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 2 }] })); // subtotal 7000

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.subtotal).toBe(7000);
    expect(body.shipping).toBe(0);
    expect(body.total).toBe(7000);
  });

  it('free-above threshold: just below it, shipping still applies', async () => {
    await setSetting('delivery_fee_type', 'fixed');
    await setSetting('delivery_fee_value', '5000');
    await setSetting('delivery_free_above', '7000');

    const { POST } = await import('./route');
    // subtotal 3500 (1 unit), below the 7000 threshold
    const res = await POST(postRequest({ items: [{ productId: PRODUCT_A_ID, qty: 1 }] }));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.shipping).toBe(5000);
  });

  it('duplicate productIds are aggregated into a single line, summed qty', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        items: [
          { productId: PRODUCT_A_ID, qty: 1 },
          { productId: PRODUCT_A_ID, qty: 2 },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].qty).toBe(3);
    expect(body.subtotal).toBe(10_500);
  });

  it('duplicate productIds summed qty exceeds stock → 422 insufficient_stock', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        items: [
          { productId: PRODUCT_A_ID, qty: 6 },
          { productId: PRODUCT_A_ID, qty: 6 },
        ],
      }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('insufficient_stock');
  });

  it('multiple distinct products → subtotal is the sum of all line totals', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        items: [
          { productId: PRODUCT_A_ID, qty: 1 },
          { productId: PRODUCT_B_ID, qty: 1 },
        ],
      }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.subtotal).toBe(7500);
    expect(body.items).toHaveLength(2);
  });
});
