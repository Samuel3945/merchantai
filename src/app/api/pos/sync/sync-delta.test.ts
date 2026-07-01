/**
 * GET /api/pos/sync?since= — delta sync DOWN (REQ-03 / REQ-09).
 *
 * Proves the device-pull contract against PGLite with the REAL queries:
 *   - first run (no `since`) returns the full catalog, empty deleted sets;
 *   - incremental (`since=T`) returns ONLY rows with updated_at > T (strict);
 *   - soft-deleted / non-published products and deleted customers land in
 *     `deleted[]` (tombstones), not `updated[]`;
 *   - the employees payload NEVER carries the bcrypt PIN hash (REQ-09);
 *   - everything is scoped to the device's org.
 *
 * Enum columns are declared as plain text in the test DDL (Drizzle reads them as
 * strings); db.select() lists every schema column, so each read-model table
 * mirrors its full column set (drizzle test-DDL rule).
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

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

const ORG = 'org_sync_delta_test';
const OTHER_ORG = 'org_other';
const T0 = '2026-06-01T00:00:00.000Z';
const T1 = '2026-06-10T00:00:00.000Z';

const SCHEMA = `
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
    unit_type text DEFAULT 'unit' NOT NULL,
    is_perishable boolean DEFAULT false NOT NULL,
    is_wholesale boolean DEFAULT false NOT NULL,
    wholesale_tiers jsonb,
    is_digital boolean DEFAULT false NOT NULL,
    digital_limit integer,
    attributes jsonb DEFAULT '{}' NOT NULL,
    size jsonb,
    status text DEFAULT 'published' NOT NULL,
    publish_at timestamp,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    icon text,
    active boolean DEFAULT true NOT NULL,
    start_hour integer,
    end_hour integer,
    sort_order integer DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}' NOT NULL,
    description text,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    document_id text,
    whatsapp text,
    email text,
    address text,
    notes text,
    marketing_opt_in boolean DEFAULT true NOT NULL,
    total_spent numeric(14, 2) DEFAULT '0' NOT NULL,
    last_purchase_at timestamp,
    created_by text,
    deleted boolean DEFAULT false NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    source text DEFAULT 'auto' NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    attribute_template jsonb DEFAULT '[]' NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE app_settings (
    organization_id text NOT NULL,
    key text NOT NULL,
    value text DEFAULT '' NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    PRIMARY KEY (organization_id, key)
  );

  CREATE TABLE pos_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text DEFAULT '' NOT NULL,
    pin text DEFAULT '' NOT NULL,
    role text DEFAULT 'cashier' NOT NULL,
    active boolean DEFAULT true NOT NULL,
    permissions jsonb DEFAULT '{}' NOT NULL,
    enabled_modules text[] DEFAULT ARRAY['pos']::text[] NOT NULL,
    can_confirm_transfers boolean DEFAULT true NOT NULL,
    session_epoch integer DEFAULT 0 NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

function syncRequest(since?: string): Request {
  const url = since
    ? `http://localhost/api/pos/sync?since=${encodeURIComponent(since)}`
    : 'http://localhost/api/pos/sync';
  return new Request(url, { method: 'GET', headers: { authorization: 'Bearer t' } });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
});

beforeEach(async () => {
  await pg.exec(
    'DELETE FROM products; DELETE FROM payment_methods; DELETE FROM customers; DELETE FROM categories; DELETE FROM app_settings; DELETE FROM pos_users;',
  );
  h.authCtx = {
    organizationId: ORG,
    cashierId: 'c1',
    cashierName: 'Tester',
    source: 'token',
    tokenId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    canConfirmTransfers: false,
    allowOversell: false,
  };
  vi.clearAllMocks();
});

describe('GET /api/pos/sync — delta down', () => {
  it('first run (no since) returns the full catalog with empty tombstones', async () => {
    await pg.query(
      `INSERT INTO products (organization_id, name, price, status, updated_at)
       VALUES ($1, 'Widget', '5.00', 'published', $2)`,
      [ORG, T0],
    );
    await pg.query(
      `INSERT INTO payment_methods (organization_id, name, type, updated_at)
       VALUES ($1, 'Efectivo', 'cash', $2)`,
      [ORG, T0],
    );
    await pg.query(
      `INSERT INTO customers (organization_id, name, updated_at) VALUES ($1, 'Cliente', $2)`,
      [ORG, T0],
    );
    await pg.query(
      `INSERT INTO categories (organization_id, name, slug, updated_at) VALUES ($1, 'Bebidas', 'bebidas', $2)`,
      [ORG, T0],
    );
    await pg.query(
      `INSERT INTO app_settings (organization_id, key, value, updated_at) VALUES ($1, 'business_name', 'Mi Tienda', $2)`,
      [ORG, T0],
    );
    await pg.query(
      `INSERT INTO pos_users (organization_id, name, email, pin, updated_at) VALUES ($1, 'Ana', 'ana@x.co', '$2b$10$h', $2)`,
      [ORG, T0],
    );

    const res = await GET(syncRequest());

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body.products.updated).toHaveLength(1);
    expect(body.products.deleted).toEqual([]);
    expect(body.payment_methods.updated).toHaveLength(1);
    expect(body.customers.updated).toHaveLength(1);
    expect(body.categories.updated).toHaveLength(1);
    expect(body.app_settings.updated).toHaveLength(1);
    expect(body.employees.updated).toHaveLength(1);
    expect(typeof body.server_time).toBe('string');
  });

  it('incremental: returns only rows changed after the watermark', async () => {
    await pg.query(
      `INSERT INTO products (organization_id, name, price, status, updated_at)
       VALUES ($1, 'Old', '1.00', 'published', $2), ($1, 'New', '2.00', 'published', $3)`,
      [ORG, T0, T1],
    );

    const res = await GET(syncRequest(T0));
    const body = await res.json();

    expect(body.products.updated).toHaveLength(1);
    expect(body.products.updated[0].name).toBe('New');
  });

  it('tombstones: archived/deleted products and deleted customers land in deleted[]', async () => {
    const archived = await pg.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, price, status, deleted, updated_at)
       VALUES ($1, 'Archivado', '1.00', 'archived', false, $2) RETURNING id`,
      [ORG, T1],
    );
    const softDel = await pg.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, price, status, deleted, updated_at)
       VALUES ($1, 'Borrado', '1.00', 'published', true, $2) RETURNING id`,
      [ORG, T1],
    );
    await pg.query(
      `INSERT INTO products (organization_id, name, price, status, updated_at)
       VALUES ($1, 'Vivo', '1.00', 'published', $2)`,
      [ORG, T1],
    );
    const delCustomer = await pg.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, deleted, updated_at)
       VALUES ($1, 'Borrado', true, $2) RETURNING id`,
      [ORG, T1],
    );

    const res = await GET(syncRequest(T0));
    const body = await res.json();

    expect(body.products.updated.map((p: { name: string }) => p.name)).toEqual(['Vivo']);
    expect(body.products.deleted).toContain(archived.rows[0]!.id);
    expect(body.products.deleted).toContain(softDel.rows[0]!.id);
    expect(body.customers.updated).toHaveLength(0);
    expect(body.customers.deleted).toContain(delCustomer.rows[0]!.id);
  });

  it('NEVER exposes the employee PIN hash, and scopes to the device org', async () => {
    await pg.query(
      `INSERT INTO pos_users (organization_id, name, email, pin, role, updated_at)
       VALUES ($1, 'Ana', 'ana@x.co', '$2b$10$secretHash', 'cashier', $2)`,
      [ORG, T0],
    );
    await pg.query(
      `INSERT INTO pos_users (organization_id, name, email, pin, updated_at)
       VALUES ($1, 'Ajeno', 'a@x.co', '$2b$10$other', $2)`,
      [OTHER_ORG, T0],
    );
    await pg.query(
      `INSERT INTO products (organization_id, name, price, status, updated_at)
       VALUES ($1, 'Ajeno', '1.00', 'published', $2)`,
      [OTHER_ORG, T0],
    );

    const res = await GET(syncRequest());
    const body = await res.json();

    expect(body.employees.updated).toHaveLength(1);

    const emp = body.employees.updated[0];

    expect(emp.name).toBe('Ana');
    expect(emp.pin).toBeUndefined();
    expect(emp.pin_hash).toBeUndefined();
    expect(emp.password_hash).toBeUndefined();
    // Cross-org rows never leak.
    expect(body.products.updated).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('secretHash');
  });
});
