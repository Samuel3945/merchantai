import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

// SQL-shape guards for the categories normalization (migration 0020 backfill +
// the usageCount recount in src/features/products/actions.ts#recountCategory).
// Run against a real Postgres engine (PGlite) so the exact statements are proven,
// the same way sales-return-sql.test.ts does for returns.

let client: PGlite;

// The backfill statement copied verbatim from migration 0020 (sans quoting).
const BACKFILL_INSERT = `
  INSERT INTO categories (organization_id, name, slug, source, usage_count)
  SELECT organization_id, MIN(btrim(category)) AS name, lower(btrim(category)) AS slug, 'manual', COUNT(*)
  FROM products
  WHERE category IS NOT NULL AND btrim(category) <> '' AND deleted = false
  GROUP BY organization_id, lower(btrim(category));
`;
const BACKFILL_LINK = `
  UPDATE products p SET category_id = c.id
  FROM categories c
  WHERE c.organization_id = p.organization_id
    AND c.slug = lower(btrim(p.category))
    AND p.category IS NOT NULL AND btrim(p.category) <> '';
`;
// The recount shape from recountCategory: usageCount = live non-deleted count.
const recount = (catId: string) => `
  UPDATE categories SET usage_count =
    (SELECT count(*)::int FROM products WHERE products.category_id = '${catId}' AND products.deleted = false)
  WHERE id = '${catId}';
`;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TYPE category_source AS ENUM('manual','ai','auto');
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      category text,
      category_id uuid,
      deleted boolean NOT NULL DEFAULT false
    );
    CREATE TABLE categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      name text NOT NULL,
      slug text NOT NULL,
      source category_source NOT NULL DEFAULT 'auto',
      usage_count integer NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX categories_org_slug_unique_idx ON categories (organization_id, slug);
  `);
});

describe('categories backfill (migration 0020)', () => {
  it('collapses by slug, counts non-deleted, isolates orgs, trims the name', async () => {
    await client.exec(`INSERT INTO products (organization_id, category, deleted) VALUES
      ('orgA','Bebidas',false),
      ('orgA','bebidas',false),
      ('orgA','  Bebidas ',false),
      ('orgA','Aseo',false),
      ('orgA',NULL,false),
      ('orgA','',false),
      ('orgA','Lacteos',true),
      ('orgB','Bebidas',false);`);

    await client.exec(BACKFILL_INSERT);
    await client.exec(BACKFILL_LINK);

    const cats = await client.query<{ organization_id: string; name: string; slug: string; usage_count: number }>(
      `SELECT organization_id, name, slug, usage_count FROM categories ORDER BY organization_id, slug`,
    );

    expect(cats.rows).toEqual([
      { organization_id: 'orgA', name: 'Aseo', slug: 'aseo', usage_count: 1 },
      { organization_id: 'orgA', name: 'Bebidas', slug: 'bebidas', usage_count: 3 },
      { organization_id: 'orgB', name: 'Bebidas', slug: 'bebidas', usage_count: 1 },
    ]);

    // Null/empty category and the deleted "Lacteos" stay unlinked.
    const linked = await client.query<{ n: number }>(
      `SELECT count(*)::int n FROM products WHERE category_id IS NOT NULL`,
    );
    const unlinked = await client.query<{ n: number }>(
      `SELECT count(*)::int n FROM products WHERE category_id IS NULL`,
    );

    expect(linked.rows[0]!.n).toBe(5);
    expect(unlinked.rows[0]!.n).toBe(3);
  });
});

describe('recountCategory invariant', () => {
  it('sets usage_count to the live count of non-deleted products', async () => {
    const cat = await client.query<{ id: string }>(
      `INSERT INTO categories (organization_id, name, slug, source) VALUES ('orgA','Bebidas','bebidas','manual') RETURNING id`,
    );
    const catId = cat.rows[0]!.id;
    await client.exec(`INSERT INTO products (organization_id, category, category_id, deleted) VALUES
      ('orgA','Bebidas','${catId}',false),
      ('orgA','Bebidas','${catId}',false),
      ('orgA','Bebidas','${catId}',true);`);

    await client.exec(recount(catId));

    const after = await client.query<{ usage_count: number }>(
      `SELECT usage_count FROM categories WHERE id = '${catId}'`,
    );

    // Two live + one deleted -> count is 2, never drifts to the raw row total.
    expect(after.rows[0]!.usage_count).toBe(2);
  });
});
