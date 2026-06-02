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

export type SalesByDayRow = {
  day: string;
  count: number;
  total: number;
};

export type CashFlowStats = {
  income: number;
  expenses: number;
  net: number;
};

export type AttentionStats = {
  outOfStock: number;
  lowStock: number;
  expiringSoon: number;
  overdueFiados: number;
};

export type DashboardMetrics = {
  range: { start: string; end: string };
  compareRange: { start: string; end: string } | null;
  period: PeriodStats;
  previousPeriod: PeriodStats | null;
  netRevenue: number;
  prevNetRevenue: number | null;
  cashFlow: CashFlowStats;
  attention: AttentionStats;
  inventory: InventoryStats;
  salesByDay: SalesByDayRow[];
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

// Net revenue = completed sales minus what was refunded back to customers in
// the same window. "What you actually kept", not gross billing.
async function netRevenue(
  orgId: string,
  start: string,
  end: string,
): Promise<number> {
  const result = await db.execute(sql`
    WITH gross AS (
      SELECT COALESCE(SUM(total), 0)::float8 AS v
      FROM sales
      WHERE organization_id = ${orgId}
        AND status = 'completed'
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${start}::date AND ${end}::date
    ),
    refunds AS (
      SELECT COALESCE(SUM(total_refunded), 0)::float8 AS v
      FROM pos_returns
      WHERE organization_id = ${orgId}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${start}::date AND ${end}::date
    )
    SELECT (gross.v - refunds.v)::float8 AS net FROM gross, refunds
  `);
  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  return toNum(row.net);
}

// Real cash-drawer flow: money in (sale + deposit) vs money out
// (expense, salary, inventory_purchase, withdrawal). This is where the owner
// finally sees that selling a lot ≠ keeping a lot.
async function cashFlowStats(
  orgId: string,
  start: string,
  end: string,
): Promise<CashFlowStats> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type IN ('sale', 'deposit')), 0)::float8 AS income,
      COALESCE(SUM(amount) FILTER (WHERE type IN ('expense', 'salary', 'inventory_purchase', 'withdrawal')), 0)::float8 AS expenses
    FROM cash_movements
    WHERE organization_id = ${orgId}
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${start}::date AND ${end}::date
  `);
  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  const income = toNum(row.income);
  const expenses = toNum(row.expenses);
  return { income, expenses, net: income - expenses };
}

// "Needs your attention today" — the counters that should make the owner act.
async function attentionStats(
  orgId: string,
): Promise<AttentionStats> {
  const [stock, expiring, fiados] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE stock <= 0)::int AS out_of_stock,
        COUNT(*) FILTER (WHERE stock BETWEEN 1 AND min_stock)::int AS low_stock
      FROM products
      WHERE organization_id = ${orgId} AND deleted = false
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS expiring
      FROM expiration_risk_cache
      WHERE organization_id = ${orgId}
        AND payload->>'tier' IN ('urgente', 'critico')
    `),
    db.execute(sql`
      WITH fiado_debt AS (
        SELECT
          s.id,
          s.total::numeric AS total,
          COALESCE((
            SELECT SUM(sp.amount) FROM sale_payments sp
            WHERE sp.sale_id = s.id AND sp.method NOT ILIKE '%fiado%'
          ), 0)::numeric AS paid,
          s.created_at
        FROM sales s
        WHERE s.organization_id = ${orgId}
          AND s.status = 'completed'
          AND (
            s.payment_type ILIKE '%fiado%'
            OR EXISTS (
              SELECT 1 FROM sale_payments sp2
              WHERE sp2.sale_id = s.id AND sp2.method ILIKE '%fiado%'
            )
          )
      )
      SELECT COUNT(*)::int AS overdue
      FROM fiado_debt
      WHERE total - paid > 0
        AND EXTRACT(day FROM NOW() - created_at) >= 7
    `),
  ]);

  const s = (stock.rows?.[0] ?? {}) as Record<string, unknown>;
  const e = (expiring.rows?.[0] ?? {}) as Record<string, unknown>;
  const f = (fiados.rows?.[0] ?? {}) as Record<string, unknown>;
  return {
    outOfStock: toInt(s.out_of_stock),
    lowStock: toInt(s.low_stock),
    expiringSoon: toInt(e.expiring),
    overdueFiados: toInt(f.overdue),
  };
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
    byDay,
    previousPeriod,
    net,
    prevNet,
    cashFlow,
    attention,
  ] = await Promise.all([
    periodStats(orgId, s, e),
    inventoryStats(orgId),
    salesByDay(orgId, s, e),
    hasCompare && cs && ce ? periodStats(orgId, cs, ce) : Promise.resolve(null),
    netRevenue(orgId, s, e),
    hasCompare && cs && ce ? netRevenue(orgId, cs, ce) : Promise.resolve(null),
    cashFlowStats(orgId, s, e),
    attentionStats(orgId),
  ]);

  return {
    range: { start: s, end: e },
    compareRange: hasCompare && cs && ce ? { start: cs, end: ce } : null,
    period,
    previousPeriod,
    netRevenue: net,
    prevNetRevenue: prevNet,
    cashFlow,
    attention,
    inventory,
    salesByDay: byDay,
  };
}
