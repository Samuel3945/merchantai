import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Integration test for the "Ventas por canal" KPI
// (actions/dashboard.ts#salesByChannel). Sales are stamped with an explicit
// `channel` at creation (pos/panel/delivery/agent — see saleChannelEnum in
// models/Schema.ts); this groups completed sales in a date range by that
// channel and zero-fills channels with no rows. Exercised against real
// Postgres via PGlite.

type Db = ReturnType<typeof drizzle>;
let pg: PGlite;
let db: Db;

const DDL = `
  CREATE TABLE sales (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    organization_id text NOT NULL,
    status text NOT NULL,
    total numeric(12, 2) NOT NULL,
    channel text DEFAULT 'pos' NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
  );
`;

const ORG = 'org-test';
const DAY = '2026-06-14';
const TS = `${DAY} 15:00:00`; // 10:00 Bogota, same calendar day
const OUT_OF_RANGE_TS = '2026-05-01 15:00:00';

type ChannelStats = { count: number; revenue: number };
type SalesByChannel = {
  pos: ChannelStats;
  panel: ChannelStats;
  delivery: ChannelStats;
  agent: ChannelStats;
};

function toNum(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toInt(value: unknown): number {
  return Math.trunc(toNum(value));
}

// Mirrors actions/dashboard.ts#salesByChannel exactly.
async function salesByChannel(start = DAY, end = DAY): Promise<SalesByChannel> {
  const result = await db.execute(sql`
    SELECT
      channel,
      COUNT(*)::int AS count,
      COALESCE(SUM(total), 0)::numeric AS revenue
    FROM sales
    WHERE organization_id = ${ORG}
      AND status = 'completed'
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY channel
  `);

  const stats: SalesByChannel = {
    pos: { count: 0, revenue: 0 },
    panel: { count: 0, revenue: 0 },
    delivery: { count: 0, revenue: 0 },
    agent: { count: 0, revenue: 0 },
  };

  for (const r of result.rows ?? []) {
    const row = r as Record<string, unknown>;
    const channel = String(row.channel ?? '');
    if (channel === 'pos' || channel === 'panel' || channel === 'delivery' || channel === 'agent') {
      stats[channel] = { count: toInt(row.count), revenue: toNum(row.revenue) };
    }
  }

  return stats;
}

async function addSale(
  channel: string,
  total: number,
  status = 'completed',
  ts = TS,
) {
  await db.execute(sql`
    INSERT INTO sales (organization_id, status, total, channel, created_at)
    VALUES (${ORG}, ${status}, ${total}, ${channel}, ${ts}::timestamp)
  `);
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg) as unknown as Db;
  await pg.exec(DDL);
});

beforeEach(async () => {
  await pg.exec('DELETE FROM sales;');
});

describe('salesByChannel KPI', () => {
  it('groups and sums completed sales by channel', async () => {
    await addSale('delivery', 50000);
    await addSale('delivery', 30000);
    await addSale('pos', 20000);
    await addSale('panel', 15000);
    await addSale('agent', 9000);

    const stats = await salesByChannel();

    expect(stats.delivery).toEqual({ count: 2, revenue: 80000 });
    expect(stats.pos).toEqual({ count: 1, revenue: 20000 });
    expect(stats.panel).toEqual({ count: 1, revenue: 15000 });
    expect(stats.agent).toEqual({ count: 1, revenue: 9000 });
  });

  it('zero-fills channels with no sales in the range', async () => {
    await addSale('pos', 10000);

    const stats = await salesByChannel();

    expect(stats.pos).toEqual({ count: 1, revenue: 10000 });
    expect(stats.delivery).toEqual({ count: 0, revenue: 0 });
    expect(stats.panel).toEqual({ count: 0, revenue: 0 });
    expect(stats.agent).toEqual({ count: 0, revenue: 0 });
  });

  it('excludes non-completed sales', async () => {
    await addSale('delivery', 40000, 'cancelled');
    await addSale('pos', 10000, 'completed');

    const stats = await salesByChannel();

    expect(stats.delivery).toEqual({ count: 0, revenue: 0 });
    expect(stats.pos).toEqual({ count: 1, revenue: 10000 });
  });

  it('excludes sales outside the date range', async () => {
    await addSale('delivery', 40000, 'completed', OUT_OF_RANGE_TS);
    await addSale('delivery', 10000, 'completed', TS);

    const stats = await salesByChannel();

    expect(stats.delivery).toEqual({ count: 1, revenue: 10000 });
  });
});
