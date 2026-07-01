/**
 * transitionDelivery — the 'delivered' → cash-sale bridge (delivery money core).
 *
 * Covers the money-critical rules:
 *   - delivered with an active shift → createSaleForOrg is called with the
 *     courier's caja (posTokenId), efectivo, items [{productId, qty}] and the
 *     delivery order id as the idempotency key; the order flips to delivered
 *     with saleId set and a status_change event recorded.
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
import { CANCEL_REASON_MESSAGES } from './cancellation-reasons';

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
  sendWhatsApp: vi.fn(
    async (_org: string, _to: unknown, _text: string) => ({ sent: false }),
  ),
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
  sendWhatsAppTextForOrg: h.sendWhatsApp,
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

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );

  CREATE TABLE cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    pos_token_id uuid,
    status text DEFAULT 'open' NOT NULL,
    opened_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE cash_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    organization_id text NOT NULL,
    type text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    reason text NOT NULL,
    category text,
    authorized_by text,
    created_by text NOT NULL,
    sale_id uuid,
    supplier_id uuid,
    corrects_session_id uuid,
    origin text,
    treasury_movement_id uuid,
    expense_id uuid,
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
  h.sendWhatsApp.mockClear();
  await pg.exec(
    'DELETE FROM delivery_events; DELETE FROM delivery_orders; DELETE FROM courier_shifts; DELETE FROM cash_movements; DELETE FROM cash_sessions; DELETE FROM app_settings;',
  );
});

async function seedShift(posTokenId: string | null): Promise<void> {
  await pg.query(
    `INSERT INTO courier_shifts (organization_id, courier_id, pos_token_id)
     VALUES ($1, $2, $3)`,
    [ORG, COURIER_ID, posTokenId],
  );
}

async function seedOpenSession(posTokenId: string | null): Promise<void> {
  await pg.query(
    `INSERT INTO cash_sessions (organization_id, pos_token_id, status)
     VALUES ($1, $2, 'open')`,
    [ORG, posTokenId],
  );
}

async function setSetting(key: string, value: string): Promise<void> {
  await pg.query(
    `INSERT INTO app_settings (organization_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $3`,
    [ORG, key, value],
  );
}

async function cashMovements(): Promise<
  Array<{ type: string; amount: string; sale_id: string | null; reason: string }>
> {
  return (
    await pg.query(
      `SELECT type, amount, sale_id, reason FROM cash_movements WHERE organization_id = $1`,
      [ORG],
    )
  ).rows as Array<{ type: string; amount: string; sale_id: string | null; reason: string }>;
}

async function noteEvents(): Promise<Array<{ note: string | null }>> {
  return (
    await pg.query(
      `SELECT note FROM delivery_events WHERE delivery_order_id = $1 AND type = 'note'`,
      [ORDER_ID],
    )
  ).rows as Array<{ note: string | null }>;
}

async function statusChangeNote(): Promise<string | null> {
  const rows = (
    await pg.query(
      `SELECT note FROM delivery_events WHERE delivery_order_id = $1 AND type = 'status_change' AND to_status = 'cancelled'`,
      [ORDER_ID],
    )
  ).rows as Array<{ note: string | null }>;
  return rows[0]?.note ?? null;
}

async function seedOrder(
  status: string,
  items: unknown[],
  phone: string | null = null,
): Promise<void> {
  await pg.query(
    `INSERT INTO delivery_orders
       (id, organization_id, status, address, customer_phone, items, subtotal, delivery_fee, total, source)
     VALUES ($1, $2, $3, 'Calle 1', $4, $5::jsonb, '2000', '1000', '3000', 'ai_agent')`,
    [ORDER_ID, ORG, status, phone, JSON.stringify(items)],
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
        idempotencyKey: ORDER_ID,
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

describe('transitionDelivery — payment method at delivery (P0-B)', () => {
  it('threads the chosen paymentType into createSaleForOrg', async () => {
    await seedShift(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 2, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered', paymentType: 'Nequi' });

    expect(h.createSale).toHaveBeenCalledWith(
      expect.objectContaining({ paymentType: 'Nequi' }),
    );
    expect((await orderRow()).status).toBe('delivered');
  });

  it('defaults to efectivo when the deliver dialog sends no method', async () => {
    await seedShift(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered' });

    expect(h.createSale).toHaveBeenCalledWith(
      expect.objectContaining({ paymentType: 'efectivo' }),
    );
  });

  it('rejects a credito method — no sale, status unchanged', async () => {
    await seedShift(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');

    await expect(
      transitionDelivery(ORDER_ID, { status: 'delivered', paymentType: 'Crédito' }),
    ).rejects.toThrow(/cr[ée]dito/i);

    expect(h.createSale).not.toHaveBeenCalled();
    expect((await orderRow()).status).toBe('assigned');
  });
});

describe('transitionDelivery — cancellation reasons (P1)', () => {
  it('stores the reason label on the status_change note and notifies with reason-specific copy', async () => {
    await seedOrder(
      'assigned',
      [{ productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 }],
      '573001234567',
    );

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, {
      status: 'cancelled',
      cancelReason: 'sin_stock',
    });

    expect(await statusChangeNote()).toBe('Sin stock');
    expect(h.sendWhatsApp).toHaveBeenCalledWith(
      ORG,
      '573001234567',
      CANCEL_REASON_MESSAGES.sin_stock,
    );
    expect((await orderRow()).status).toBe('cancelled');
  });

  it('otro reason stores the label + free text on the note', async () => {
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, {
      status: 'cancelled',
      cancelReason: 'otro',
      cancelReasonText: 'se cayó la moto',
    });

    expect(await statusChangeNote()).toBe('Otro motivo — se cayó la moto');
  });
});

describe('transitionDelivery — delivery fee settlement (P2-B)', () => {
  it('revenue mode + cash: books the fee as a deposit into the sale caja', async () => {
    await seedShift(DEVICE_ID);
    await seedOpenSession(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 2, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered' });

    const mv = await cashMovements();

    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({
      type: 'deposit',
      amount: '1000.00',
      sale_id: SALE_ID,
      reason: 'Cobro de domicilio',
    });
  });

  it('revenue mode + non-cash (transfer): no caja deposit', async () => {
    await seedShift(DEVICE_ID);
    await seedOpenSession(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered', paymentType: 'Nequi' });

    expect(await cashMovements()).toHaveLength(0);
  });

  it('courier_tip mode: records a tip note, never a caja deposit', async () => {
    await setSetting('delivery_fee_mode', 'courier_tip');
    await seedShift(DEVICE_ID);
    await seedOpenSession(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered' });

    expect(await cashMovements()).toHaveLength(0);

    const notes = await noteEvents();

    expect(notes.some(n => n.note?.startsWith('Propina domiciliario'))).toBe(true);
  });

  it('revenue mode + cash: the deposit is idempotent across a re-run', async () => {
    await seedShift(DEVICE_ID);
    await seedOpenSession(DEVICE_ID);
    await seedOrder('assigned', [
      { productId: PRODUCT_ID, qty: 1, name: 'Arroz', price: 1000 },
    ]);

    const { transitionDelivery } = await import('./actions');
    await transitionDelivery(ORDER_ID, { status: 'delivered' });
    // A second delivered call (already delivered → idempotent) must NOT double
    // the fee deposit.
    await transitionDelivery(ORDER_ID, { status: 'delivered' });

    expect(await cashMovements()).toHaveLength(1);
  });
});
