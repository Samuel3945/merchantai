import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { saleItemsSchema, salesSchema } from '@/models/Schema';

// Regression guard for the return-aggregation SQL in src/actions/sales.ts
// (hasReturn, fullyReturned, getSaleForReturn.returnedQty).
//
// These are correlated subqueries. They MUST use literal, table-qualified refs
// (e.g. `sales.id`, alias `pri.sale_item_id`) — NOT drizzle column interpolation
// `${table.column}`, which renders the column UNqualified inside sql``. A bare
// "id" inside the subquery binds to the INNER table's own id, so the correlation
// never matches and the aggregate is silently always false/0. That shipped once
// and made the Sales view show initial (not remaining) units on returns.
//
// We run the exact SQL shapes against a real Postgres engine (pglite) to prove
// the correlation resolves to the OUTER row.

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client);
  await client.exec(`
    CREATE TABLE sales (id text PRIMARY KEY);
    CREATE TABLE sale_items (id text PRIMARY KEY, sale_id text, qty int);
    CREATE TABLE pos_returns (id text PRIMARY KEY, sale_id text);
    CREATE TABLE pos_return_items (id text PRIMARY KEY, sale_item_id text, qty int);

    INSERT INTO sales (id) VALUES ('s1'), ('s2'), ('s3');
    -- s1: sold 5, returned 2 -> partial
    INSERT INTO sale_items (id, sale_id, qty) VALUES ('si1', 's1', 5);
    INSERT INTO pos_returns (id, sale_id) VALUES ('r1', 's1');
    INSERT INTO pos_return_items (id, sale_item_id, qty) VALUES ('pri1', 'si1', 2);
    -- s2: sold 3, returned 3 -> fully returned
    INSERT INTO sale_items (id, sale_id, qty) VALUES ('si2', 's2', 3);
    INSERT INTO pos_returns (id, sale_id) VALUES ('r2', 's2');
    INSERT INTO pos_return_items (id, sale_item_id, qty) VALUES ('pri2', 'si2', 3);
    -- s3: sold 4, no returns -> clean
    INSERT INTO sale_items (id, sale_id, qty) VALUES ('si3', 's3', 4);
  `);
});

const hasReturn = sql<boolean>`EXISTS (SELECT 1 FROM pos_returns pr WHERE pr.sale_id = sales.id)`;

const fullyReturned = sql<boolean>`(
  EXISTS (SELECT 1 FROM pos_returns pr WHERE pr.sale_id = sales.id)
  AND COALESCE((
    SELECT SUM(pri.qty)
    FROM pos_return_items pri
    JOIN sale_items si ON si.id = pri.sale_item_id
    WHERE si.sale_id = sales.id
  ), 0) >= COALESCE((
    SELECT SUM(si2.qty) FROM sale_items si2 WHERE si2.sale_id = sales.id
  ), 0)
)`;

const returnedQty = sql<number>`COALESCE((
  SELECT SUM(pri.qty)
  FROM pos_return_items pri
  WHERE pri.sale_item_id = sale_items.id
), 0)::int`;

describe('sales return aggregation SQL', () => {
  it('computes hasReturn / fullyReturned per sale (correlation hits outer sales.id)', async () => {
    const rows = await db
      .select({ id: salesSchema.id, hasReturn, fullyReturned })
      .from(salesSchema)
      .orderBy(salesSchema.id);

    expect(rows).toEqual([
      { id: 's1', hasReturn: true, fullyReturned: false },
      { id: 's2', hasReturn: true, fullyReturned: true },
      { id: 's3', hasReturn: false, fullyReturned: false },
    ]);
  });

  it('computes returnedQty per sale item (correlation hits outer sale_items.id)', async () => {
    const rows = await db
      .select({ id: saleItemsSchema.id, returnedQty })
      .from(saleItemsSchema)
      .orderBy(saleItemsSchema.id);

    expect(rows).toEqual([
      { id: 'si1', returnedQty: 2 },
      { id: 'si2', returnedQty: 3 },
      { id: 'si3', returnedQty: 0 },
    ]);
  });
});
