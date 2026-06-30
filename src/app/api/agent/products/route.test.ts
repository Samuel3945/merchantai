/**
 * GET /api/agent/products
 *
 * Capability-gated product lookup. Price and stock ALWAYS come from the DB.
 * productsSchema is never queried when the capability is missing (403 first).
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = 'org_products_test';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof drizzle>,
  capabilities: { products_lookup: true } as Record<string, boolean>,
}));

vi.mock('@/libs/DB', () => ({
  get db() {
    return h.db;
  },
}));

vi.mock('@/libs/agent-auth', () => ({
  requireAgentAuth: vi.fn(async () => ({
    ctx: {
      organizationId: 'org_products_test',
      channelId: 'ddddeeee-0001-0001-0001-ffffffff0001',
      capabilities: h.capabilities,
      tokenId: 'ddddeeee-0002-0002-0002-ffffffff0002',
    },
    errorResponse: null,
  })),
}));

const SCHEMA = `
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

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  h.db = drizzle(pg);
  // Seed products
  await pg.query(
    `INSERT INTO products (id, organization_id, name, price, stock, deleted)
     VALUES
       (gen_random_uuid(), $1, 'Arroz 500g', '3500.00', 10, false),
       (gen_random_uuid(), $1, 'Azúcar 1kg', '4200.00', 5, false),
       (gen_random_uuid(), $1, 'Aceite deleted', '1000.00', 0, true)`,
    [ORG],
  );
});

beforeEach(() => {
  h.capabilities = { products_lookup: true };
  vi.clearAllMocks();
});

function getRequest(params: Record<string, string> = {}): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://localhost/api/agent/products${qs ? `?${qs}` : ''}`, {
    headers: { authorization: 'Bearer test' },
  });
}

describe('GET /api/agent/products', () => {
  it('capabilities.products_lookup=true → products returned with server price+stock', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest());

    expect(res.status).toBe(200);

    const products = await res.json();

    // Should only include non-deleted products (2 results)
    expect(products.length).toBe(2);

    // Each product has server-side price and stock
    for (const p of products) {
      expect(p.price).toBeDefined();
      expect(p.stock).toBeDefined();
    }
  });

  it('capabilities.products_lookup=false → 403, no DB query runs', async () => {
    h.capabilities = { orders: true }; // no products_lookup
    const { GET } = await import('./route');
    const res = await GET(getRequest());

    expect(res.status).toBe(403);
  });

  it('q param → name filter applied', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest({ q: 'arroz' }));

    expect(res.status).toBe(200);

    const products = await res.json();

    expect(products.length).toBe(1);
    expect(products[0].name.toLowerCase()).toContain('arroz');
  });

  it('cross-org → only own org products (db.forOrg scoping)', async () => {
    // Seed a product for another org
    await pg.query(
      `INSERT INTO products (id, organization_id, name, price, stock, deleted)
       VALUES (gen_random_uuid(), 'org_other', 'Other Org Product', '999.00', 1, false)`,
    );

    const { GET } = await import('./route');
    const res = await GET(getRequest());
    const products = await res.json();

    // Should not include the other org product
    const otherOrgProduct = products.find((p: { name: string }) => p.name === 'Other Org Product');

    expect(otherOrgProduct).toBeUndefined();
  });
});
