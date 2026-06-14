import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Integration test for the net-revenue KPI math (actions/dashboard.ts#netRevenue).
// A fully-returned sale keeps its `total` but flips status to 'returned'. The
// gross CTE must therefore count 'returned' sales (their original billing) so the
// refund nets them to ~0 — filtering gross to 'completed' only made a same-window
// full return read as -refund instead of 0. Exercised against real Postgres.

type Db = ReturnType<typeof drizzle>;
let pg: PGlite;
let db: Db;

const DDL = `
  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    status text NOT NULL,
    total numeric(12, 2) NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE pos_returns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    total_refunded numeric(12, 2) NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-test';
const DAY = '2026-06-14';
const TS = `${DAY} 15:00:00`; // 10:00 Bogota, same calendar day

// The corrected netRevenue query (gross over real sales − refunds in the window).
async function netRevenue(start = DAY, end = DAY): Promise<number> {
  const r = await db.execute(sql`
    WITH gross AS (
      SELECT COALESCE(SUM(total), 0)::float8 AS v
      FROM sales
      WHERE organization_id = ${ORG}
        AND status IN ('completed', 'settled', 'returned')
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${start}::date AND ${end}::date
    ),
    refunds AS (
      SELECT COALESCE(SUM(total_refunded), 0)::float8 AS v
      FROM pos_returns
      WHERE organization_id = ${ORG}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${start}::date AND ${end}::date
    )
    SELECT (gross.v - refunds.v)::float8 AS net FROM gross, refunds
  `);
  return Number((r.rows?.[0] as { net: number }).net);
}

async function addSale(status: string, total: number) {
  await db.execute(sql`
    INSERT INTO sales (organization_id, status, total, created_at)
    VALUES (${ORG}, ${status}, ${total}, ${TS}::timestamp)
  `);
}
async function addRefund(amount: number) {
  await db.execute(sql`
    INSERT INTO pos_returns (organization_id, total_refunded, created_at)
    VALUES (${ORG}, ${amount}, ${TS}::timestamp)
  `);
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Db;
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM sales; DELETE FROM pos_returns;');
});

describe('netRevenue KPI', () => {
  it('a fully-returned sale in the window nets to 0, not negative', async () => {
    await addSale('returned', 100); // was 'completed', flipped on full return
    await addRefund(100);

    expect(await netRevenue()).toBe(0);
  });

  it('a partial return nets gross minus the refund', async () => {
    await addSale('completed', 100);
    await addRefund(30);

    expect(await netRevenue()).toBe(70);
  });

  it('a clean sale with no return counts in full', async () => {
    await addSale('completed', 100);

    expect(await netRevenue()).toBe(100);
  });

  it('excludes cancelled sales from gross', async () => {
    await addSale('cancelled', 100);

    expect(await netRevenue()).toBe(0);
  });
});
