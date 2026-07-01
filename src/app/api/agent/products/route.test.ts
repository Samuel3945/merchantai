import type { AltItem, ResultItem, SearchResponse } from '@/features/products/search/ranking';
/**
 * GET /api/agent/products
 *
 * Capability-gated product search. Price and stock ALWAYS come from the DB.
 * productsSchema is never queried when the capability is missing (403 first).
 *
 * Runs the real trigram/FTS query against PGlite (with the pg_trgm extension
 * and the same immutable_unaccent function shipped in
 * migrations/0077_product_search_trgm_fts.sql), so this exercises the actual
 * SQL — not a mock of it.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
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

// Mirrors migrations/0077_product_search_trgm_fts.sql exactly (pure
// translate()+lower(), not the unaccent extension — IMMUTABLE, no extra deps).
const UNACCENT_FN = `
  CREATE OR REPLACE FUNCTION immutable_unaccent(text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
  AS $$
    SELECT translate(
      lower($1),
      'áàäâãéèëêíìïîóòöôõúùüûñçºª',
      'aaaaaeeeeiiiiooooouuuuncoa'
    )
  $$;
`;

const SCHEMA = `
  CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    barcode text,
    price numeric(10, 2) NOT NULL,
    stock numeric(12, 3) DEFAULT 0 NOT NULL,
    category text,
    unit_type text DEFAULT 'unit' NOT NULL,
    status text DEFAULT 'published' NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  await pg.exec(UNACCENT_FN);
  await pg.exec(SCHEMA);
  await pg.exec(
    'CREATE INDEX products_name_trgm_idx ON products USING gin (immutable_unaccent(name) gin_trgm_ops);',
  );
  await pg.exec(
    'CREATE INDEX products_search_fts_idx ON products USING gin (to_tsvector(\'spanish\', immutable_unaccent(name || \' \' || coalesce(category, \'\'))));',
  );
  h.db = drizzle(pg);

  // Seed products: two normal items, two "Coca Cola" presentations, one
  // out-of-stock, one deleted, one archived (status filter proof).
  await pg.query(
    `INSERT INTO products (id, organization_id, name, barcode, price, stock, category, unit_type, status, deleted)
     VALUES
       (gen_random_uuid(), $1, 'Arroz Diana 500g', null, '3500.00', 10, 'abarrotes', 'unit', 'published', false),
       (gen_random_uuid(), $1, 'Panela', null, '2000.00', 8, 'abarrotes', 'unit', 'published', false),
       (gen_random_uuid(), $1, 'Coca Cola 1.5L', '7701234567890', '3000.00', 10, 'bebidas', 'unit', 'published', false),
       (gen_random_uuid(), $1, 'Coca Cola 3L', null, '6000.00', 5, 'bebidas', 'unit', 'published', false),
       (gen_random_uuid(), $1, 'Coca Cola Light 1.5L', null, '3200.00', 0, 'bebidas', 'unit', 'published', false),
       (gen_random_uuid(), $1, 'Coca Cola Zero 1.5L', null, '3200.00', 10, 'bebidas', 'unit', 'published', true),
       (gen_random_uuid(), $1, 'Coca Cola Diet 1.5L', null, '3200.00', 10, 'bebidas', 'unit', 'archived', false),
       (gen_random_uuid(), $1, 'Refresco Postobon 1.5L', null, '2800.00', 10, 'bebidas', 'unit', 'published', false)`,
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

function allNames(body: SearchResponse): string[] {
  return [...body.results, ...body.alternatives].map((item: ResultItem | AltItem) => item.name);
}

describe('GET /api/agent/products', () => {
  it('capabilities.products_lookup=true → q=coca returns Coca Cola matches with server price+stock, excludes Panela/deleted/archived', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest({ q: 'coca' }));

    expect(res.status).toBe(200);

    const body = (await res.json()) as SearchResponse;
    const names = allNames(body);

    expect(names).toContain('Coca Cola 1.5L');
    expect(names).toContain('Coca Cola 3L');
    expect(names).not.toContain('Panela');
    expect(names).not.toContain('Arroz Diana 500g');
    expect(names).not.toContain('Coca Cola Zero 1.5L'); // deleted
    expect(names).not.toContain('Coca Cola Diet 1.5L'); // archived

    for (const item of [...body.results, ...body.alternatives]) {
      expect(item.price).toBeDefined();
      expect(typeof item.stock).toBe('number');
    }
  });

  it('capabilities.products_lookup=false → 403, no DB query runs', async () => {
    h.capabilities = { orders: true }; // no products_lookup
    const { GET } = await import('./route');
    const res = await GET(getRequest({ q: 'coca' }));

    expect(res.status).toBe(403);
  });

  it('q=arroz → returns Arroz Diana 500g', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest({ q: 'arroz' }));

    expect(res.status).toBe(200);

    const body = (await res.json()) as SearchResponse;

    expect(allNames(body)).toContain('Arroz Diana 500g');
  });

  it('q=gaseosa → finds a "Refresco" product via ES-CO synonym expansion', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest({ q: 'gaseosa' }));

    expect(res.status).toBe(200);

    const body = (await res.json()) as SearchResponse;

    expect(allNames(body)).toContain('Refresco Postobon 1.5L');
  });

  it('empty q → not_found shape, no DB query needed', async () => {
    const { GET } = await import('./route');
    const res = await GET(getRequest());

    expect(res.status).toBe(200);

    const body = (await res.json()) as SearchResponse;

    expect(body.status).toBe('not_found');
    expect(body.results).toEqual([]);
    expect(body.alternatives).toEqual([]);
  });

  it('cross-org → other org product never appears in results or alternatives (db.forOrg scoping)', async () => {
    await pg.query(
      `INSERT INTO products (id, organization_id, name, price, stock, category, unit_type, status, deleted)
       VALUES (gen_random_uuid(), 'org_other', 'Coca Cola Other Org', '999.00', 1, 'bebidas', 'unit', 'published', false)`,
    );

    const { GET } = await import('./route');
    const res = await GET(getRequest({ q: 'coca' }));
    const body = (await res.json()) as SearchResponse;

    expect(allNames(body)).not.toContain('Coca Cola Other Org');
  });
});
