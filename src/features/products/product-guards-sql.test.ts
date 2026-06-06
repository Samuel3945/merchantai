import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { productsSchema } from '@/models/Schema';

// Regression guard for the EXISTS probes in src/features/products/actions.ts
// (hasSales / hasMovements / hasDatedBatches). They are correlated subqueries and
// MUST use literal, table-qualified refs (alias si/sm + outer products.id), NOT
// drizzle column interpolation ${table.column} (which renders unqualified inside
// sql`` — a bare "id" then binds to the inner table's own id, making EXISTS
// always false and wrongly marking every product as virgin/deletable).

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client);
  await client.exec(`
    CREATE TABLE products (id text PRIMARY KEY);
    CREATE TABLE sale_items (id text PRIMARY KEY, product_id text);
    CREATE TABLE stock_movements (id text PRIMARY KEY, product_id text, expires_at date, remaining_qty int);

    INSERT INTO products (id) VALUES ('p1'), ('p2'), ('p3'), ('p4');
    -- p1: has a sale, no movements
    INSERT INTO sale_items (id, product_id) VALUES ('item1', 'p1');
    -- p2: has a dated batch with stock
    INSERT INTO stock_movements (id, product_id, expires_at, remaining_qty) VALUES ('m2', 'p2', '2027-01-01', 5);
    -- p3: virgin (nothing)
    -- p4: has a movement but no expiry date
    INSERT INTO stock_movements (id, product_id, expires_at, remaining_qty) VALUES ('m4', 'p4', NULL, 3);
  `);
});

const hasSales = sql<boolean>`EXISTS (SELECT 1 FROM sale_items si WHERE si.product_id = products.id)`;
const hasMovements = sql<boolean>`EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.product_id = products.id)`;
const hasDatedBatches = sql<boolean>`EXISTS (
  SELECT 1 FROM stock_movements sm
  WHERE sm.product_id = products.id
    AND sm.expires_at IS NOT NULL
    AND COALESCE(sm.remaining_qty, 0) > 0
)`;

describe('product guard EXISTS probes', () => {
  it('resolve correlation against the outer products.id', async () => {
    const rows = await db
      .select({
        id: productsSchema.id,
        hasSales,
        hasMovements,
        hasDatedBatches,
      })
      .from(productsSchema)
      .orderBy(productsSchema.id);

    expect(rows).toEqual([
      { id: 'p1', hasSales: true, hasMovements: false, hasDatedBatches: false },
      { id: 'p2', hasSales: false, hasMovements: true, hasDatedBatches: true },
      { id: 'p3', hasSales: false, hasMovements: false, hasDatedBatches: false },
      { id: 'p4', hasSales: false, hasMovements: true, hasDatedBatches: false },
    ]);
  });
});
