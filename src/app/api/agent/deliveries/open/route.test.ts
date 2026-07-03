/**
 * GET/POST /api/agent/deliveries/open
 *
 * The bot works ONLY by phone (never an order id). Covers:
 *   1. GET open pending order → found:true with items+total, no id
 *   2. GET only a delivered order → found:false
 *   3. POST adds items to a pending order → merged, recomputed, 200 ok
 *   4. POST when order is in_transit → 409 order_not_addable, unchanged
 *   5. POST when no open order → 404 no_open_order
 *   6. POST insufficient stock (existing+new qty > stock) → 422 insufficient_stock
 *   7. POST to an 'assigned' order with a courier phone → notifies courier
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_open_deliveries_test';
const PRODUCT_ID = 'eeeeeeee-0004-4004-8004-ffffffffffff';
const PRODUCT_LOW_STOCK_ID = 'eeeeeeee-0005-4005-8005-ffffffffffff';
const COURIER_ID = 'eeeeeeee-0006-4006-8006-ffffffffffff';
const PHONE = '3001234567';

const sendWhatsAppTextForOrgMock = vi.fn(
  async (_orgId: string, _to: string | null | undefined, _text: string) =>
    ({ sent: true }) as const,
);

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
      organizationId: 'org_open_deliveries_test',
      channelId: 'eeeeeeee-0001-0001-0001-ffffffffffff',
      capabilities: h.capabilities,
      tokenId: 'eeeeeeee-0002-0002-0002-ffffffffffff',
    },
    errorResponse: null,
  })),
}));

vi.mock('@/libs/delivery-whatsapp', () => ({
  sendWhatsAppTextForOrg: sendWhatsAppTextForOrgMock,
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

  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    phone text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE delivery_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_id uuid,
    sale_id uuid,
    courier_id uuid,
    status text DEFAULT 'pending' NOT NULL,
    customer_name text,
    customer_phone text,
    address text NOT NULL,
    address_notes text,
    items jsonb DEFAULT '[]' NOT NULL,
    subtotal numeric(12, 2) DEFAULT '0' NOT NULL,
    delivery_fee numeric(12, 2) DEFAULT '0' NOT NULL,
    total numeric(12, 2) DEFAULT '0' NOT NULL,
    source text DEFAULT 'manual' NOT NULL,
    notes text,
    delivery_photo_url text,
    assigned_at timestamp,
    in_transit_at timestamp,
    delivered_at timestamp,
    cancelled_at timestamp,
    created_by text,
    idempotency_key text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE delivery_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    delivery_order_id uuid NOT NULL,
    organization_id text NOT NULL,
    type text NOT NULL,
    from_status text,
    to_status text,
    note text,
    actor_type text DEFAULT 'user' NOT NULL,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);

  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Arroz 500g', '3500.00', 10)`,
    [PRODUCT_ID, ORG],
  );
  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Producto Bajo Stock', '2000.00', 3)`,
    [PRODUCT_LOW_STOCK_ID, ORG],
  );
  await pg.query(
    `INSERT INTO pos_users (id, organization_id, name, phone) VALUES ($1, $2, 'Carlos Courier', '3009998877')`,
    [COURIER_ID, ORG],
  );
});

beforeEach(async () => {
  h.capabilities = { orders: true };
  sendWhatsAppTextForOrgMock.mockClear();
  await pg.exec('DELETE FROM delivery_events;');
  await pg.exec('DELETE FROM delivery_orders;');
  await pg.exec('DELETE FROM app_settings;');
});

async function insertOrder(opts: {
  id: string;
  status: string;
  items: Array<{ name: string; qty: number; price: number; productId?: string }>;
  courierId?: string | null;
  customerName?: string | null;
}): Promise<void> {
  await pg.query(
    `INSERT INTO delivery_orders
       (id, organization_id, customer_phone, customer_name, courier_id, status, address, items, subtotal, delivery_fee, total, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Calle 123', $7, $8, '0', $8, 'manual', now(), now())`,
    [
      opts.id,
      ORG,
      PHONE,
      opts.customerName ?? 'Juan Cliente',
      opts.courierId ?? null,
      opts.status,
      JSON.stringify(opts.items),
      opts.items.reduce((sum, it) => sum + it.qty * it.price, 0).toFixed(2),
    ],
  );
}

function getRequest(phone: string): Request {
  return new Request(
    `http://localhost/api/agent/deliveries/open?phone=${encodeURIComponent(phone)}`,
    { headers: { authorization: 'Bearer test' } },
  );
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/deliveries/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/agent/deliveries/open', () => {
  it('open pending order → found:true with items+total, no id', async () => {
    await insertOrder({
      id: 'aaaaaaaa-0001-4001-8001-000000000001',
      status: 'pending',
      items: [{ name: 'Arroz 500g', qty: 2, price: 3500, productId: PRODUCT_ID }],
    });

    const { GET } = await import('./route');
    const res = await GET(getRequest(PHONE));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.found).toBe(true);
    expect(body.status).toBe('pending');
    expect(body.items).toEqual([{ name: 'Arroz 500g', qty: 2 }]);
    expect(body.total).toBe(7000);
    expect(body.id).toBeUndefined();
  });

  it('only a delivered order exists → found:false', async () => {
    await insertOrder({
      id: 'aaaaaaaa-0002-4002-8002-000000000002',
      status: 'delivered',
      items: [{ name: 'Arroz 500g', qty: 1, price: 3500, productId: PRODUCT_ID }],
    });

    const { GET } = await import('./route');
    const res = await GET(getRequest(PHONE));

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.found).toBe(false);
  });

  it('capabilities.orders=false → 403', async () => {
    h.capabilities = { products_lookup: true };

    const { GET } = await import('./route');
    const res = await GET(getRequest(PHONE));

    expect(res.status).toBe(403);
  });
});

describe('POST /api/agent/deliveries/open', () => {
  it('adds items to a pending order → merged, subtotal/fee/total recomputed, 200 ok', async () => {
    const orderId = 'aaaaaaaa-0003-4003-8003-000000000003';
    await insertOrder({
      id: orderId,
      status: 'pending',
      items: [{ name: 'Arroz 500g', qty: 1, price: 3500, productId: PRODUCT_ID }],
    });

    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_LOW_STOCK_ID, qty: 2 }] }),
    );

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.status).toBe('ok');
    expect(body.added).toEqual([{ name: 'Producto Bajo Stock', qty: 2 }]);
    // subtotal = 1*3500 + 2*2000 = 7500; no fee configured → total = 7500
    expect(body.newTotal).toBe(7500);

    const [row] = (await pg.query(
      `SELECT items, subtotal, total FROM delivery_orders WHERE id = $1`,
      [orderId],
    )).rows as Array<{ items: unknown; subtotal: string; total: string }>;

    expect(row!.items).toEqual([
      { name: 'Arroz 500g', qty: 1, price: 3500, productId: PRODUCT_ID },
      { name: 'Producto Bajo Stock', qty: 2, price: 2000, productId: PRODUCT_LOW_STOCK_ID },
    ]);
    expect(Number(row!.subtotal)).toBe(7500);
    expect(Number(row!.total)).toBe(7500);
  });

  it('order is in_transit → 409 order_not_addable, order unchanged', async () => {
    const orderId = 'aaaaaaaa-0004-4004-8004-000000000004';
    await insertOrder({
      id: orderId,
      status: 'in_transit',
      items: [{ name: 'Arroz 500g', qty: 1, price: 3500, productId: PRODUCT_ID }],
    });

    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_ID, qty: 1 }] }),
    );

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.code).toBe('order_not_addable');
    expect(body.status).toBe('in_transit');

    const [row] = (await pg.query(
      `SELECT items FROM delivery_orders WHERE id = $1`,
      [orderId],
    )).rows as Array<{ items: unknown }>;

    expect(row!.items).toEqual([{ name: 'Arroz 500g', qty: 1, price: 3500, productId: PRODUCT_ID }]);
  });

  it('no open order → 404 no_open_order', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_ID, qty: 1 }] }),
    );

    expect(res.status).toBe(404);

    const body = await res.json();

    expect(body.code).toBe('no_open_order');
  });

  it('insufficient stock (existing+new qty > stock) → 422 insufficient_stock', async () => {
    // PRODUCT_LOW_STOCK_ID has stock=3; order already has qty=2, requesting 2 more = 4 > 3
    const orderId = 'aaaaaaaa-0005-4005-8005-000000000005';
    await insertOrder({
      id: orderId,
      status: 'pending',
      items: [{ name: 'Producto Bajo Stock', qty: 2, price: 2000, productId: PRODUCT_LOW_STOCK_ID }],
    });

    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_LOW_STOCK_ID, qty: 2 }] }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('insufficient_stock');
    expect(body.available).toBe(3);
    expect(body.requested).toBe(4);

    const [row] = (await pg.query(
      `SELECT items FROM delivery_orders WHERE id = $1`,
      [orderId],
    )).rows as Array<{ items: unknown }>;

    expect(row!.items).toEqual([
      { name: 'Producto Bajo Stock', qty: 2, price: 2000, productId: PRODUCT_LOW_STOCK_ID },
    ]);
  });

  it('assigned order with a courier that has a phone → notifies the courier', async () => {
    const orderId = 'aaaaaaaa-0006-4006-8006-000000000006';
    await insertOrder({
      id: orderId,
      status: 'assigned',
      items: [{ name: 'Arroz 500g', qty: 1, price: 3500, productId: PRODUCT_ID }],
      courierId: COURIER_ID,
      customerName: 'Maria Cliente',
    });

    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_LOW_STOCK_ID, qty: 1 }] }),
    );

    expect(res.status).toBe(200);
    expect(sendWhatsAppTextForOrgMock).toHaveBeenCalledOnce();

    const [orgArg, phoneArg, textArg] = sendWhatsAppTextForOrgMock.mock.calls[0]!;

    expect(orgArg).toBe(ORG);
    expect(phoneArg).toBe('3009998877');
    expect(textArg).toContain('Producto Bajo Stock');
  });

  it('unknown key in body (e.g. price) → 400 (strict schema rejects it)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_ID, qty: 1, price: 999 }] }),
    );

    expect(res.status).toBe(400);
  });

  it('capabilities.orders=false → 403', async () => {
    h.capabilities = { products_lookup: true };

    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ phone: PHONE, items: [{ productId: PRODUCT_ID, qty: 1 }] }),
    );

    expect(res.status).toBe(403);
  });
});
