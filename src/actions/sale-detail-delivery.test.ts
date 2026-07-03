/**
 * getSaleDetail — delivery process section (Sales view Part B)
 *
 * A sale stamped channel = 'delivery' links back to its delivery_orders row
 * (delivery_orders.sale_id = sales.id) and that order's delivery_events. This
 * regression guard proves getSaleDetail resolves the linked order + its
 * ordered event timeline into `delivery`, and that a plain POS sale (no
 * linked delivery order) returns `delivery: null`.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  orgId: 'org-delivery-detail',
  userId: 'user_test',
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
    orgRole: 'org:admin',
  })),
  currentUser: vi.fn(async () => ({ fullName: 'Test User' })),
  clerkClient: vi.fn(async () => ({
    users: {
      getUserList: vi.fn(async () => ({ data: [] })),
    },
  })),
}));

const SETUP_SQL = `
  CREATE TYPE "sale_status" AS ENUM('completed', 'settled', 'returned');
  CREATE TYPE "sale_channel" AS ENUM('pos', 'panel', 'delivery', 'agent');
  CREATE TYPE "pos_return_reason" AS ENUM('customer_request', 'damaged');
  CREATE TYPE "pos_return_disposition" AS ENUM('restock', 'damaged', 'discard');
  CREATE TYPE "delivery_status" AS ENUM('pending', 'assigned', 'in_transit', 'delivered', 'cancelled');
  CREATE TYPE "delivery_event_type" AS ENUM('created', 'assigned', 'status_change', 'note', 'customer_notified');
  CREATE TYPE "audit_actor_type" AS ENUM('user', 'cashier', 'api', 'system');
  CREATE TYPE "pos_user_role" AS ENUM('admin', 'cashier', 'courier');

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

  CREATE TABLE sale_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    qty numeric(12, 3) NOT NULL,
    price numeric(10, 2) NOT NULL,
    subtotal numeric(10, 2) NOT NULL,
    unit_type text DEFAULT 'unit' NOT NULL
  );

  CREATE TABLE sale_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    method text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    bills_paid jsonb,
    change_given numeric(10, 2) DEFAULT '0' NOT NULL,
    reference text,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE pos_returns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    sale_id uuid NOT NULL,
    reason "pos_return_reason" NOT NULL,
    notes text,
    total_refunded numeric(12, 2) DEFAULT '0' NOT NULL,
    refund_method text NOT NULL,
    partial boolean DEFAULT false NOT NULL,
    cashier_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE pos_return_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    return_id uuid NOT NULL,
    sale_item_id uuid NOT NULL,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    qty numeric(12, 3) NOT NULL,
    refund_amount numeric(12, 2) DEFAULT '0' NOT NULL,
    restock boolean DEFAULT true NOT NULL,
    disposition "pos_return_disposition" DEFAULT 'restock' NOT NULL
  );

  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    pin text DEFAULT '' NOT NULL,
    role "pos_user_role" NOT NULL,
    active boolean DEFAULT true NOT NULL
  );

  CREATE TABLE delivery_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    customer_id uuid,
    sale_id uuid,
    courier_id uuid,
    status "delivery_status" DEFAULT 'pending' NOT NULL,
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
    type "delivery_event_type" NOT NULL,
    from_status "delivery_status",
    to_status "delivery_status",
    note text,
    actor_type "audit_actor_type" DEFAULT 'user' NOT NULL,
    created_by text,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = h.orgId;
const UUID = (i: number): string =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

let pg: PGlite;
let counter = 0;

beforeAll(async () => {
  pg = new PGlite();
  h.db = drizzle(pg);
  await pg.exec(SETUP_SQL);
});

beforeEach(() => {
  counter += 1000;
});

describe('getSaleDetail — delivery process', () => {
  it('returns delivery with ordered events for a channel=delivery sale', async () => {
    const { getSaleDetail } = await import('@/actions/sales');

    const saleId = UUID(counter + 1);
    const courierId = UUID(counter + 2);
    const orderId = UUID(counter + 3);
    const productId = UUID(counter + 4);
    const itemId = UUID(counter + 5);

    await pg.query(
      `INSERT INTO pos_users (id, organization_id, name, email, password_hash, role)
       VALUES ($1, $2, 'Repartidor Juan', 'juan@example.com', 'x', 'courier')`,
      [courierId, ORG],
    );

    await pg.query(
      `INSERT INTO sales (id, organization_id, sale_number, total, payment_type, channel)
       VALUES ($1, $2, 42, '50000.00', 'Efectivo', 'delivery')`,
      [saleId, ORG],
    );

    await pg.query(
      `INSERT INTO sale_items (id, sale_id, product_id, product_name, qty, price, subtotal)
       VALUES ($1, $2, $3, 'Producto A', 1, '50000.00', '50000.00')`,
      [itemId, saleId, productId],
    );

    await pg.query(
      `INSERT INTO delivery_orders (id, organization_id, sale_id, courier_id, status, address)
       VALUES ($1, $2, $3, $4, 'delivered', 'Calle 123 #45-67')`,
      [orderId, ORG, saleId, courierId],
    );

    // Insert events out of chronological order to prove the ORDER BY works.
    await pg.query(
      `INSERT INTO delivery_events (delivery_order_id, organization_id, type, to_status, created_at)
       VALUES ($1, $2, 'status_change', 'delivered', now())`,
      [orderId, ORG],
    );
    await pg.query(
      `INSERT INTO delivery_events (delivery_order_id, organization_id, type, created_at)
       VALUES ($1, $2, 'created', now() - interval '10 minutes')`,
      [orderId, ORG],
    );
    await pg.query(
      `INSERT INTO delivery_events (delivery_order_id, organization_id, type, from_status, to_status, created_at)
       VALUES ($1, $2, 'status_change', 'pending', 'in_transit', now() - interval '5 minutes')`,
      [orderId, ORG],
    );

    const detail = await getSaleDetail(saleId);

    expect(detail).not.toBeNull();
    expect(detail!.delivery).not.toBeNull();
    expect(detail!.delivery!.status).toBe('delivered');
    expect(detail!.delivery!.address).toBe('Calle 123 #45-67');
    expect(detail!.delivery!.courierName).toBe('Repartidor Juan');
    expect(detail!.delivery!.events.map(e => e.type)).toEqual([
      'created',
      'status_change',
      'status_change',
    ]);
    expect(detail!.delivery!.events.map(e => e.toStatus)).toEqual([
      null,
      'in_transit',
      'delivered',
    ]);
  });

  it('returns delivery: null for a plain POS sale', async () => {
    const { getSaleDetail } = await import('@/actions/sales');

    const saleId = UUID(counter + 6);

    await pg.query(
      `INSERT INTO sales (id, organization_id, sale_number, total, payment_type, channel)
       VALUES ($1, $2, 43, '10000.00', 'Efectivo', 'pos')`,
      [saleId, ORG],
    );

    const detail = await getSaleDetail(saleId);

    expect(detail).not.toBeNull();
    expect(detail!.delivery).toBeNull();
  });
});
