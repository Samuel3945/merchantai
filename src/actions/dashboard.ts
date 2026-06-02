'use server';

import { auth } from '@clerk/nextjs/server';
import { sql } from 'drizzle-orm';
import { db } from '@/libs/DB';

export type PeriodStats = {
  total: number;
  count: number;
  avgTicket: number;
  profit: number;
  margin: number;
};

export type InventoryStats = {
  value: number;
  outOfStock: number;
  lowStock: number;
  total: number;
};

export type TopProduct = {
  id: string;
  name: string;
  qty: number;
  revenue: number;
};

export type PaymentBreakdownRow = {
  paymentType: string;
  count: number;
  total: number;
};

export type SalesByHourRow = {
  hour: number;
  count: number;
  total: number;
};

export type SalesByDayRow = {
  day: string;
  count: number;
  total: number;
};

export type CategoryBreakdownRow = {
  category: string;
  qty: number;
  revenue: number;
};

export type CashierBreakdownRow = {
  cashierId: string;
  count: number;
  total: number;
};

export type DashboardMetrics = {
  range: { start: string; end: string };
  compareRange: { start: string; end: string } | null;
  period: PeriodStats;
  previousPeriod: PeriodStats | null;
  inventory: InventoryStats;
  topProducts: TopProduct[];
  paymentBreakdown: PaymentBreakdownRow[];
  salesByHour: SalesByHourRow[];
  salesByDay: SalesByDayRow[];
  categoryBreakdown: CategoryBreakdownRow[];
  cashierBreakdown: CashierBreakdownRow[];
};

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

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

async function periodStats(
  orgId: string,
  start: string,
  end: string,
): Promise<PeriodStats> {
  const result = await db.execute(sql`
    WITH ps AS (
      SELECT id, total::numeric AS total
      FROM sales
      WHERE organization_id = ${orgId}
        AND status = 'completed'
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${start}::date AND ${end}::date
    ),
    costs AS (
      SELECT sm.sale_id, SUM(sm.qty * COALESCE(sm.unit_cost, 0)) AS cost
      FROM stock_movements sm
      WHERE sm.type = 'exit'
        AND sm.sale_id IN (SELECT id FROM ps)
      GROUP BY sm.sale_id
    )
    SELECT
      COALESCE(SUM(ps.total), 0)::float8 AS total,
      COUNT(ps.id)::int AS count,
      COALESCE(AVG(ps.total), 0)::float8 AS avg_ticket,
      COALESCE(SUM(ps.total - COALESCE(c.cost, 0)), 0)::float8 AS profit,
      CASE
        WHEN COALESCE(SUM(ps.total), 0) > 0
          THEN (SUM(ps.total - COALESCE(c.cost, 0)) / SUM(ps.total) * 100)::float8
        ELSE 0
      END AS margin
    FROM ps
    LEFT JOIN costs c ON c.sale_id = ps.id
  `);

  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  return {
    total: toNum(row.total),
    count: toInt(row.count),
    avgTicket: toNum(row.avg_ticket),
    profit: toNum(row.profit),
    margin: toNum(row.margin),
  };
}

async function inventoryStats(orgId: string): Promise<InventoryStats> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(cost * stock), 0)::float8 AS value,
      COUNT(*) FILTER (WHERE stock <= 0)::int AS out_of_stock,
      COUNT(*) FILTER (WHERE stock BETWEEN 1 AND 5)::int AS low_stock,
      COUNT(*)::int AS total
    FROM products
    WHERE organization_id = ${orgId}
      AND deleted = false
  `);

  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  return {
    value: toNum(row.value),
    outOfStock: toInt(row.out_of_stock),
    lowStock: toInt(row.low_stock),
    total: toInt(row.total),
  };
}

async function topProducts(
  orgId: string,
  start: string,
  end: string,
): Promise<TopProduct[]> {
  const result = await db.execute(sql`
    SELECT
      p.id::text AS id,
      p.name AS name,
      SUM(si.qty)::int AS qty,
      SUM(si.subtotal)::float8 AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.organization_id = ${orgId}
      AND s.status = 'completed'
      AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY p.id, p.name
    ORDER BY revenue DESC
    LIMIT 10
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      qty: toInt(row.qty),
      revenue: toNum(row.revenue),
    };
  });
}

async function paymentBreakdown(
  orgId: string,
  start: string,
  end: string,
): Promise<PaymentBreakdownRow[]> {
  const result = await db.execute(sql`
    SELECT
      payment_type,
      COUNT(*)::int AS count,
      SUM(total)::float8 AS total
    FROM sales
    WHERE organization_id = ${orgId}
      AND status = 'completed'
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY payment_type
    ORDER BY total DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      paymentType: String(row.payment_type ?? ''),
      count: toInt(row.count),
      total: toNum(row.total),
    };
  });
}

async function salesByHour(
  orgId: string,
  start: string,
  end: string,
): Promise<SalesByHourRow[]> {
  const result = await db.execute(sql`
    SELECT
      EXTRACT(hour FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'))::int AS hour,
      COUNT(*)::int AS count,
      SUM(total)::float8 AS total
    FROM sales
    WHERE organization_id = ${orgId}
      AND status = 'completed'
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY hour
    ORDER BY hour
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      hour: toInt(row.hour),
      count: toInt(row.count),
      total: toNum(row.total),
    };
  });
}

async function salesByDay(
  orgId: string,
  start: string,
  end: string,
): Promise<SalesByDayRow[]> {
  const result = await db.execute(sql`
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS count,
      SUM(total)::float8 AS total
    FROM sales
    WHERE organization_id = ${orgId}
      AND status = 'completed'
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY day
    ORDER BY day
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      day: String(row.day ?? ''),
      count: toInt(row.count),
      total: toNum(row.total),
    };
  });
}

async function categoryBreakdown(
  orgId: string,
  start: string,
  end: string,
): Promise<CategoryBreakdownRow[]> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(p.category, 'Sin categoría') AS category,
      SUM(si.qty)::int AS qty,
      SUM(si.subtotal)::float8 AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.organization_id = ${orgId}
      AND s.status = 'completed'
      AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY p.category
    ORDER BY revenue DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      category: String(row.category ?? 'Sin categoría'),
      qty: toInt(row.qty),
      revenue: toNum(row.revenue),
    };
  });
}

async function cashierBreakdown(
  orgId: string,
  start: string,
  end: string,
): Promise<CashierBreakdownRow[]> {
  // Note: no `users` table in schema — cashier identity is the Clerk user ID
  // stored in sales.cashier_id. Grouping by that ID; the UI resolves names
  // separately if needed.
  const result = await db.execute(sql`
    SELECT
      cashier_id,
      COUNT(*)::int AS count,
      SUM(total)::float8 AS total
    FROM sales
    WHERE organization_id = ${orgId}
      AND status = 'completed'
      AND cashier_id IS NOT NULL
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
    GROUP BY cashier_id
    ORDER BY total DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      cashierId: String(row.cashier_id ?? ''),
      count: toInt(row.count),
      total: toNum(row.total),
    };
  });
}

function validateDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${field}: expected YYYY-MM-DD`);
  }
  return value;
}

export async function getMetrics(
  start: string,
  end: string,
  compareStart?: string,
  compareEnd?: string,
): Promise<DashboardMetrics> {
  const { orgId } = await requireOrg();

  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const hasCompare = Boolean(compareStart && compareEnd);
  const cs = compareStart ? validateDate(compareStart, 'compareStart') : null;
  const ce = compareEnd ? validateDate(compareEnd, 'compareEnd') : null;

  const [
    period,
    inventory,
    top,
    payments,
    byHour,
    byDay,
    byCategory,
    byCashier,
    previousPeriod,
  ] = await Promise.all([
    periodStats(orgId, s, e),
    inventoryStats(orgId),
    topProducts(orgId, s, e),
    paymentBreakdown(orgId, s, e),
    salesByHour(orgId, s, e),
    salesByDay(orgId, s, e),
    categoryBreakdown(orgId, s, e),
    cashierBreakdown(orgId, s, e),
    hasCompare && cs && ce ? periodStats(orgId, cs, ce) : Promise.resolve(null),
  ]);

  return {
    range: { start: s, end: e },
    compareRange: hasCompare && cs && ce ? { start: cs, end: ce } : null,
    period,
    previousPeriod,
    inventory,
    topProducts: top,
    paymentBreakdown: payments,
    salesByHour: byHour,
    salesByDay: byDay,
    categoryBreakdown: byCategory,
    cashierBreakdown: byCashier,
  };
}
