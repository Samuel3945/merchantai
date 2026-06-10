import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { inferBusinessType } from '@/libs/business-profile';

// SQL-shape guards for the business_profile aggregates in
// libs/business-profile.ts#recomputeBusinessProfile, run against a real Postgres
// engine (PGlite) so the exact statements are proven — plus a pure unit test for
// the inferBusinessType heuristic.

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      status text NOT NULL DEFAULT 'published',
      is_perishable boolean NOT NULL DEFAULT false,
      is_wholesale boolean NOT NULL DEFAULT false,
      category_id uuid,
      stock integer NOT NULL DEFAULT 0,
      price numeric(10,2) NOT NULL,
      deleted boolean NOT NULL DEFAULT false
    );
    CREATE TABLE sales (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      status text NOT NULL DEFAULT 'completed',
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE sale_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id uuid NOT NULL,
      product_id uuid NOT NULL,
      qty integer NOT NULL
    );
    CREATE TABLE stock_movements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      type text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      name text NOT NULL,
      usage_count integer NOT NULL DEFAULT 0
    );
  `);
});

describe('business_profile catalog aggregate', () => {
  it('counts catalog shape, isolates org, excludes deleted', async () => {
    const cat = await client.query<{ id: string }>(
      `INSERT INTO categories (organization_id, name, usage_count) VALUES ('orgA','Bebidas',2) RETURNING id`,
    );
    const catId = cat.rows[0]!.id;
    await client.exec(`INSERT INTO products (organization_id, status, is_perishable, is_wholesale, category_id, stock, price, deleted) VALUES
      ('orgA','published', true,  false, '${catId}', 10, '1000', false),
      ('orgA','published', false, true,  '${catId}', 5,  '3000', false),
      ('orgA','archived',  false, false, NULL,       0,  '2000', false),
      ('orgA','published', false, false, NULL,       1,  '9999', true),
      ('orgB','published', false, false, NULL,       7,  '500',  false);`);

    const res = await client.query<Record<string, unknown>>(`
      SELECT
        count(*)::int AS product_count,
        count(*) FILTER (WHERE status = 'published')::int AS active_product_count,
        count(*) FILTER (WHERE is_perishable)::int AS perishable_count,
        count(*) FILTER (WHERE is_wholesale)::int AS wholesale_count,
        count(DISTINCT category_id)::int AS distinct_categories,
        COALESCE(sum(stock), 0)::int AS total_stock_units,
        ROUND(AVG(price), 2) AS avg_price,
        MIN(price) AS min_price,
        MAX(price) AS max_price
      FROM products
      WHERE organization_id = 'orgA' AND deleted = false`);

    const r = res.rows[0]!;

    expect(r.product_count).toBe(3); // deleted row excluded
    expect(r.active_product_count).toBe(2);
    expect(r.perishable_count).toBe(1);
    expect(r.wholesale_count).toBe(1);
    expect(r.distinct_categories).toBe(1);
    expect(r.total_stock_units).toBe(15); // 10 + 5 + 0
    expect(Number(r.avg_price)).toBe(2000); // (1000+3000+2000)/3
    expect(Number(r.min_price)).toBe(1000);
    expect(Number(r.max_price)).toBe(3000);
  });
});

describe('business_profile commerce window', () => {
  it('counts only finalized sales inside the 30-day window', async () => {
    const recent = await client.query<{ id: string }>(
      `INSERT INTO sales (organization_id, status, created_at) VALUES ('orgA','completed', now() - interval '2 days') RETURNING id`,
    );
    const settled = await client.query<{ id: string }>(
      `INSERT INTO sales (organization_id, status, created_at) VALUES ('orgA','settled', now() - interval '5 days') RETURNING id`,
    );
    // Excluded: cancelled, and a completed sale older than 30 days.
    const cancelled = await client.query<{ id: string }>(
      `INSERT INTO sales (organization_id, status, created_at) VALUES ('orgA','cancelled', now() - interval '1 day') RETURNING id`,
    );
    const old = await client.query<{ id: string }>(
      `INSERT INTO sales (organization_id, status, created_at) VALUES ('orgA','completed', now() - interval '40 days') RETURNING id`,
    );
    const p1 = '11111111-1111-1111-1111-111111111111';
    const p2 = '22222222-2222-2222-2222-222222222222';
    await client.exec(`INSERT INTO sale_items (sale_id, product_id, qty) VALUES
      ('${recent.rows[0]!.id}','${p1}',3),
      ('${recent.rows[0]!.id}','${p2}',2),
      ('${settled.rows[0]!.id}','${p1}',1),
      ('${cancelled.rows[0]!.id}','${p1}',9),
      ('${old.rows[0]!.id}','${p1}',9);`);

    const res = await client.query<Record<string, unknown>>(`
      SELECT
        COALESCE(sum(si.qty), 0)::int AS units_sold_30d,
        count(DISTINCT s.id)::int AS sales_count_30d,
        count(DISTINCT si.product_id)::int AS distinct_products_sold_30d
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.organization_id = 'orgA'
        AND s.created_at >= now() - interval '30 days'
        AND s.status IN ('completed', 'settled')`);

    const r = res.rows[0]!;

    expect(r.units_sold_30d).toBe(6); // 3 + 2 + 1, cancelled/old excluded
    expect(r.sales_count_30d).toBe(2);
    expect(r.distinct_products_sold_30d).toBe(2);
  });
});

describe('inferBusinessType', () => {
  it('classifies from objective ratios', () => {
    expect(inferBusinessType({ productCount: 0, perishableCount: 0, wholesaleCount: 0 })).toBeNull();
    expect(inferBusinessType({ productCount: 10, perishableCount: 6, wholesaleCount: 1 })).toBe('grocery_fresh');
    expect(inferBusinessType({ productCount: 10, perishableCount: 1, wholesaleCount: 8 })).toBe('wholesale');
    expect(inferBusinessType({ productCount: 10, perishableCount: 1, wholesaleCount: 1 })).toBe('retail_general');
  });
});
