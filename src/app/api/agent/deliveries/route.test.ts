/**
 * POST /api/agent/deliveries
 *
 * Full ownership chain + server price re-fetch.
 * All 7 spec scenarios from §Delivery Order Creation:
 *   1. capabilities.orders=false → 403
 *   2. cross-org customerId → 404
 *   3. product missing/deleted → 422 product_not_found
 *   4. insufficient stock → 422 insufficient_stock
 *   5. LLM price in body → server price used, LLM price discarded
 *   6. successful delivery → source=ai_agent, actorType=api, createdBy=tokenId
 *   7. phone-only (no customerId) → delivery created with phone snapshot
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_deliveries_test';
const TOKEN_ID = 'eeeeeeee-0002-0002-0002-ffffffffffff';
const CUSTOMER_ID = 'eeeeeeee-0003-4003-8003-ffffffffffff';
const PRODUCT_ID = 'eeeeeeee-0004-4004-8004-ffffffffffff';
const PRODUCT_LOW_STOCK_ID = 'eeeeeeee-0005-4005-8005-ffffffffffff';

const createDeliveryMock = vi.fn(async (_orgId: string, _input: unknown, _opts: unknown) => ({
  id: 'delivery-id-001',
  organizationId: ORG,
  source: 'ai_agent',
  createdBy: TOKEN_ID,
}));

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
      organizationId: 'org_deliveries_test',
      channelId: 'eeeeeeee-0001-0001-0001-ffffffffffff',
      capabilities: h.capabilities,
      tokenId: 'eeeeeeee-0002-0002-0002-ffffffffffff',
    },
    errorResponse: null,
  })),
}));

vi.mock('@/features/delivery/intake', () => ({
  createDeliveryForOrg: createDeliveryMock,
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

const SCHEMA = `
  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    whatsapp text,
    document_id text,
    deleted boolean DEFAULT false NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
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
    assigned_at timestamp,
    in_transit_at timestamp,
    delivered_at timestamp,
    cancelled_at timestamp,
    created_by text,
    idempotency_key text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);

  // Seed data
  await pg.query(
    `INSERT INTO customers (id, organization_id, name) VALUES ($1, $2, 'Juan Cliente')`,
    [CUSTOMER_ID, ORG],
  );
  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Arroz 500g', '3500.00', 10)`,
    [PRODUCT_ID, ORG],
  );
  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock) VALUES ($1, $2, 'Producto Agotado', '2000.00', 0)`,
    [PRODUCT_LOW_STOCK_ID, ORG],
  );
});

beforeEach(() => {
  h.capabilities = { orders: true };
  createDeliveryMock.mockClear();
});

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/deliveries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  remoteJid: '573001234567@s.whatsapp.net',
  customerId: CUSTOMER_ID,
  items: [{ productId: PRODUCT_ID, qty: 2 }],
  address: 'Calle 123 # 45-67',
};

describe('POST /api/agent/deliveries', () => {
  it('capabilities.orders=false → 403', async () => {
    h.capabilities = { products_lookup: true }; // no orders
    const { POST } = await import('./route');
    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(403);
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  it('cross-org customerId → 404', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ ...VALID_BODY, customerId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }),
    );

    expect(res.status).toBe(404);
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  it('product missing/deleted → 422 product_not_found', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        ...VALID_BODY,
        items: [{ productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', qty: 1 }],
      }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('product_not_found');
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  it('insufficient stock (allowOversell:false) → 422 insufficient_stock', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        ...VALID_BODY,
        items: [{ productId: PRODUCT_LOW_STOCK_ID, qty: 5 }],
      }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('insufficient_stock');
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  it('LLM-supplied price in body → server price used, LLM price discarded', async () => {
    const { POST } = await import('./route');
    // The body does not have price (agentDeliveryCreateSchema rejects it) but
    // the test verifies that the snapshot passed to createDeliveryForOrg uses
    // the server price (3500), not any caller-supplied value.
    await POST(postRequest(VALID_BODY));

    expect(createDeliveryMock).toHaveBeenCalledOnce();

    const [, inputArg] = createDeliveryMock.mock.calls[0]!;
    const items = (inputArg as { items: Array<{ price: number }> }).items;

    expect(items[0]!.price).toBe(3500); // server price, not any LLM value
  });

  it('successful delivery → source=ai_agent, actorType=api, createdBy=tokenId', async () => {
    const { POST } = await import('./route');
    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(createDeliveryMock).toHaveBeenCalledOnce();

    const [orgArg, , optsArg] = createDeliveryMock.mock.calls[0]!;

    expect(orgArg).toBe(ORG);
    expect(optsArg).toMatchObject({
      source: 'ai_agent',
      actorType: 'api',
      createdBy: TOKEN_ID,
    });
  });

  it('phone-only (no customerId) → delivery created with phone snapshot, no customer row required', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        remoteJid: '573001234567@s.whatsapp.net',
        phone: '3001234567',
        items: [{ productId: PRODUCT_ID, qty: 1 }],
        address: 'Calle 99',
      }),
    );

    expect(res.status).toBe(201);
    expect(createDeliveryMock).toHaveBeenCalledOnce();

    // No customer lookup failure for phone-only flow
    const [, inputArg] = createDeliveryMock.mock.calls[0]!;

    expect((inputArg as { customerPhone?: string }).customerPhone).toBe('3001234567');
  });

  it('item body carrying unknown key "price" → 400 (strict schema rejects it)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        ...VALID_BODY,
        items: [{ productId: PRODUCT_ID, qty: 1, price: 999 }],
      }),
    );

    expect(res.status).toBe(400);
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  it('duplicate productId items summed qty exceeds stock → 422 insufficient_stock', async () => {
    // PRODUCT_ID has stock=10; two items of qty=6 sum to 12 → exceeds stock
    const { POST } = await import('./route');
    const res = await POST(
      postRequest({
        ...VALID_BODY,
        items: [
          { productId: PRODUCT_ID, qty: 6 },
          { productId: PRODUCT_ID, qty: 6 },
        ],
      }),
    );

    expect(res.status).toBe(422);

    const body = await res.json();

    expect(body.code).toBe('insufficient_stock');
    expect(createDeliveryMock).not.toHaveBeenCalled();
  });

  // ─── Idempotency dedup ────────────────────────────────────────────────────

  it('known idempotencyKey (pre-existing row) → 200 with existing id, no duplicate creation', async () => {
    // Simulate a row already created by a previous n8n invocation
    await pg.query(
      `INSERT INTO delivery_orders
         (id, organization_id, address, items, subtotal, delivery_fee, total, source, idempotency_key, created_at, updated_at)
       VALUES ('aaaaaaaa-d001-4001-8001-000000000001', $1, 'Calle 10', '[]', '0', '0', '0', 'ai_agent', 'wa-msg-idempotency-001', now(), now())`,
      [ORG],
    );

    const { POST } = await import('./route');
    const res = await POST(
      postRequest({ ...VALID_BODY, idempotencyKey: 'wa-msg-idempotency-001' }),
    );

    expect(res.status).toBe(200);
    expect(createDeliveryMock).not.toHaveBeenCalled();

    const body = await res.json();

    expect(body.id).toBe('aaaaaaaa-d001-4001-8001-000000000001');
  });

  it('first call with new idempotencyKey → 201; second call after row exists → 200 same id', async () => {
    const key = 'wa-msg-idempotency-002';
    const { POST } = await import('./route');

    // First call — row doesn't exist yet, mock creates it
    const res1 = await POST(postRequest({ ...VALID_BODY, idempotencyKey: key }));

    expect(res1.status).toBe(201);
    expect(createDeliveryMock).toHaveBeenCalledOnce();

    // Manually seed the row as if createDeliveryForOrg had inserted it
    await pg.query(
      `INSERT INTO delivery_orders
         (id, organization_id, address, items, subtotal, delivery_fee, total, source, idempotency_key, created_at, updated_at)
       VALUES ('bbbbbbbb-d002-4002-8002-000000000002', $1, 'Calle 20', '[]', '0', '0', '0', 'ai_agent', $2, now(), now())`,
      [ORG, key],
    );

    createDeliveryMock.mockClear();

    // Second call — row exists, should return 200 with the existing id
    const res2 = await POST(postRequest({ ...VALID_BODY, idempotencyKey: key }));

    expect(res2.status).toBe(200);
    expect(createDeliveryMock).not.toHaveBeenCalled();

    const body2 = await res2.json();

    expect(body2.id).toBe('bbbbbbbb-d002-4002-8002-000000000002');
  });

  it('different idempotencyKey per call → distinct creation attempts (no dedup)', async () => {
    const { POST } = await import('./route');

    await POST(postRequest({ ...VALID_BODY, idempotencyKey: 'unique-key-aaa' }));
    await POST(postRequest({ ...VALID_BODY, idempotencyKey: 'unique-key-bbb' }));

    // Both calls should have triggered createDeliveryForOrg (two distinct orders)
    expect(createDeliveryMock).toHaveBeenCalledTimes(2);
  });

  it('no idempotencyKey → createDeliveryForOrg called normally (backward compat)', async () => {
    const { POST } = await import('./route');
    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(201);
    expect(createDeliveryMock).toHaveBeenCalledOnce();
  });
});
