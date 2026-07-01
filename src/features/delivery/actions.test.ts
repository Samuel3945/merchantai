/**
 * transitionDelivery — the 'delivered' → cash-sale bridge (delivery money core).
 *
 * Covers the money-critical rules:
 *   - delivered with an active shift → createSaleForOrg is called with the
 *     courier's caja (posTokenId), efectivo, items [{productId, qty}] and the
 *     `delivery:<id>` idempotency key; the order flips to delivered with saleId
 *     set and a status_change event recorded.
 *   - delivered WITHOUT a shift → rejected, no sale, status unchanged.
 *   - delivered with a legacy line missing productId → rejected, no sale.
 *   - a non-delivered transition (in_transit) needs no shift and no sale.
 *
 * createSaleForOrg is mocked (its FIFO/stock/cash core is tested elsewhere); this
 * suite verifies transitionDelivery's orchestration. In-memory PGlite backs the
 * delivery tables; Clerk auth is org:admin so requirePanelModule passes and
 * getCurrentPanelUser resolves the courier from the seeded pos_users row.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_deliver_test';
const CLERK_ID = 'user_courier_clerk';
const COURIER_ID = 'bbbbbbbb-0001-4001-8001-000000000001';
const DEVICE_ID = 'bbbbbbbb-0002-4002-8002-000000000002';
const ORDER_ID = 'bbbbbbbb-0003-4003-8003-000000000003';
const PRODUCT_ID = 'bbbbbbbb-0004-4004-8004-000000000004';
const SALE_ID = 'bbbbbbbb-0005-4005-8005-000000000005';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  // Literals (not the module consts) — vi.hoisted runs before those are init'd.
  auth: {
    userId: 'user_courier_clerk' as string | null,
    orgId: 'org_deliver_test' as string | null,
    orgRole: 'org:admin' as string,
  },
  createSale: vi.fn(async (_input: unknown) => ({
    id: 'bbbbbbbb-0005-4005-8005-000000000005',
    total: '2000.00',
    saleNumber: 1,
    status: 'completed',
    deduped: false,
    items: [],
    payments: [],
  })),
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => h.auth),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/actions/sales', () => ({
  createSaleForOrg: h.createSale,
}));

vi.mock('@/libs/delivery-whatsapp', () => ({
  sendWhatsAppTextForOrg: vi.fn(async () => ({ sent: false })),
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

const SCHEMA = `
  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text,
    enabled_modules text[] DEFAULT '{}' NOT NULL,
    clerk_user_id text,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE courier_shifts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    courier_id uuid NOT NULL,
    pos_token_id uuid,
    started_at timestamp DEFAULT now() NOT NULL,
    ended_at timestamp
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
    `INSERT INTO pos_users (id, organization_id, name, clerk_user_id, active)
     VALUES ($1, $2, 'Cami Courier', $3, true)`,
    [COURIER_ID, ORG, CLERK_ID],
  );
});

beforeEach(async () => {
  h.auth = { userId: CLERK_ID, orgId: ORG, orgRole: 'org:admin' };
  h.createSale.mockClear();
  await pg.exec(
    'DELETE FROM delivery_events; DELETE FROM delivery_orders; DELETE FROM courier_shifts;',
  );
});

async function seedShift(posTokenId: string | null): Promise<void> {
  await pg.query(
    `INSERT INTO courier_shifts (organization_id, courier_id, pos_token_id)
     VALUES ($1, $2, $3)`,
    [ORG, COURIER_ID, posTokenId],
  );
}

async function seedOrder(
  status: string,
  items: unknown[],
): Promise<void> {
  await pg.query(
    `INSERT INTO delivery_orders
       (id, organization_id, status, address, items, subtotal, delivery_fee, total, source)
     VALUES ($1, $2, $3, 'Calle 1', $4::jsonb, '2000', '1000', '3000', 'ai_agent')`,
    [ORDER_ID, ORG, status, JSON.stringify(items)],
  );
}

async function orderRow(): Promise<{
  status: string;
  sale_id: string | null;
  delivered_at: unknown;
}> {
  const rows = (
    await pg.query(
      `SELECT status, sale_id, delivered_at FROM delivery_orders WHERE id = $1`,
      [ORDER_ID],
    )
  ).rows as Array<{ status: string; sale_id: string | null; delivered_at: unknown }>;
  return rows[0]!;
}

describe('transitionDelivery — delivered → cash sale', () => {
  it('delivered with an active shift creates the sale in the caja and sets saleId', async () => {
    await seedShift(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 2, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered' });

    expect(h.createSale).toHaveBeenCalledOnce();
    expect(h.createSale).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        actorId: COURIER_ID,
        actorType: 'api',
        paymentType: 'efectivo',
        posTokenId: DEVICE_ID,
        idempotencyKey: `delivery:${ORDER_ID}`,
        items: [{ productId: PRODUCT_ID, qty: 2 }],
      }),
    );

    const order = await orderRow();

    expect(order.status).toBe('delivered');
    expect(order.sale_id).toBe(SALE_ID);
    expect(order.delivered_at).not.toBeNull();

    const events = (
      await pg.query(
        `SELECT to_status FROM delivery_events WHERE delivery_order_id = $1 AND type = 'status_change'`,
        [ORDER_ID],
      )
    ).rows as Array<{ to_status: string }>;

    expect(events.some(e => e.to_status === 'delivered')).toBe(true);
  });

  it('delivered WITHOUT an active shift is rejected — no sale, status unchanged', async () => {
    // No shift seeded.
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');

    await expect(
      transitionDelivery(ORDER_ID, { status: 'delivered' }),
    ).rejects.toThrow(/Iniciá tu jornada/i);

    expect(h.createSale).not.toHaveBeenCalled();
    expect((await orderRow()).status).toBe('assigned');
  });

  it('delivered with a legacy line missing productId is rejected — no sale', async () => {
    await seedShift(DEVICE_ID);
    await seedOrder('assigned', [
      { qty: 1, name: 'Producto libre sin id', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');

    await expect(
      transitionDelivery(ORDER_ID, { status: 'delivered' }),
    ).rejects.toThrow(/manualmente/i);

    expect(h.createSale).not.toHaveBeenCalled();
    expect((await orderRow()).status).toBe('assigned');
  });

  it('a non-delivered transition (in_transit) needs no shift and creates no sale', async () => {
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'in_transit' });

    expect(h.createSale).not.toHaveBeenCalled();
    expect((await orderRow()).status).toBe('in_transit');
  });
});
