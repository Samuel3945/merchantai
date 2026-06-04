'use server';

import { auth } from '@clerk/nextjs/server';
import { sql } from 'drizzle-orm';
import { db } from '@/libs/DB';

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

function validateDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${field}: expected YYYY-MM-DD`);
  }
  return value;
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) {
    return 0;
  }
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: unknown): number {
  return Math.trunc(toNum(v));
}

function rows(result: { rows?: unknown[] }): Record<string, unknown>[] {
  return (result.rows ?? []) as Record<string, unknown>[];
}

// ── Cash flow ────────────────────────────────────────────────────────────────
// Real money in/out of the register. Income = sale + deposit; expenses =
// expense + salary + inventory_purchase. A security withdrawal (withdrawal)
// only moves cash to a safe/bank, so it is NOT a financial expense and is
// excluded here; same for `adjustment`, a reconciliation entry.

export type CashFlowByType = { type: string; amount: number };
export type CashFlowDay = { day: string; income: number; expenses: number };

export type CashFlowReport = {
  income: number;
  expenses: number;
  net: number;
  byType: CashFlowByType[];
  daily: CashFlowDay[];
};

const INCOME_TYPES = sql`('sale', 'deposit')`;
const EXPENSE_TYPES = sql`('expense', 'salary', 'inventory_purchase')`;

export async function getCashFlow(
  start: string,
  end: string,
): Promise<CashFlowReport> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const [totals, byType, daily] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type IN ${INCOME_TYPES}), 0)::float8 AS income,
        COALESCE(SUM(amount) FILTER (WHERE type IN ${EXPENSE_TYPES}), 0)::float8 AS expenses
      FROM cash_movements
      WHERE organization_id = ${orgId}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
    `),
    db.execute(sql`
      SELECT type, COALESCE(SUM(amount), 0)::float8 AS amount
      FROM cash_movements
      WHERE organization_id = ${orgId}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
      GROUP BY type
      ORDER BY amount DESC
    `),
    db.execute(sql`
      SELECT
        to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(amount) FILTER (WHERE type IN ${INCOME_TYPES}), 0)::float8 AS income,
        COALESCE(SUM(amount) FILTER (WHERE type IN ${EXPENSE_TYPES}), 0)::float8 AS expenses
      FROM cash_movements
      WHERE organization_id = ${orgId}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
      GROUP BY day
      ORDER BY day
    `),
  ]);

  const t = (totals.rows?.[0] ?? {}) as Record<string, unknown>;
  const income = toNum(t.income);
  const expenses = toNum(t.expenses);

  return {
    income,
    expenses,
    net: income - expenses,
    byType: rows(byType).map(r => ({
      type: String(r.type ?? ''),
      amount: toNum(r.amount),
    })),
    daily: rows(daily).map(r => ({
      day: String(r.day ?? ''),
      income: toNum(r.income),
      expenses: toNum(r.expenses),
    })),
  };
}

// ── Returns / devoluciones ─────────────────────────────────────────────────

export type ReturnReasonRow = { reason: string; count: number; amount: number };
export type ReturnedProductRow = { productName: string; qty: number; amount: number };

export type ReturnsReport = {
  totalRefunded: number;
  returnCount: number;
  salesCount: number;
  returnRate: number; // returns / sales, as %
  byReason: ReturnReasonRow[];
  topProducts: ReturnedProductRow[];
};

export async function getReturnsAnalysis(
  start: string,
  end: string,
): Promise<ReturnsReport> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const [totals, byReason, topProducts] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(total_refunded), 0)::float8 AS total_refunded,
        COUNT(*)::int AS return_count,
        (
          SELECT COUNT(*) FROM sales sa
          WHERE sa.organization_id = ${orgId}
            AND sa.status = 'completed'
            AND (sa.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
                BETWEEN ${s}::date AND ${e}::date
        )::int AS sales_count
      FROM pos_returns r
      WHERE r.organization_id = ${orgId}
        AND (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
    `),
    db.execute(sql`
      SELECT reason, COUNT(*)::int AS count, COALESCE(SUM(total_refunded), 0)::float8 AS amount
      FROM pos_returns
      WHERE organization_id = ${orgId}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
      GROUP BY reason
      ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT
        ri.product_name,
        SUM(ri.qty)::int AS qty,
        COALESCE(SUM(ri.refund_amount), 0)::float8 AS amount
      FROM pos_return_items ri
      JOIN pos_returns r ON r.id = ri.return_id
      WHERE r.organization_id = ${orgId}
        AND (r.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
      GROUP BY ri.product_name
      ORDER BY qty DESC
      LIMIT 20
    `),
  ]);

  const t = (totals.rows?.[0] ?? {}) as Record<string, unknown>;
  const returnCount = toInt(t.return_count);
  const salesCount = toInt(t.sales_count);

  return {
    totalRefunded: toNum(t.total_refunded),
    returnCount,
    salesCount,
    returnRate: salesCount > 0 ? (returnCount / salesCount) * 100 : 0,
    byReason: rows(byReason).map(r => ({
      reason: String(r.reason ?? ''),
      count: toInt(r.count),
      amount: toNum(r.amount),
    })),
    topProducts: rows(topProducts).map(r => ({
      productName: String(r.product_name ?? ''),
      qty: toInt(r.qty),
      amount: toNum(r.amount),
    })),
  };
}

// ── Customer insights ───────────────────────────────────────────────────────
// Snapshot based: sales has no customer FK, so per-range revenue per customer
// is not available. We lean on customers.totalSpent / lastPurchaseAt instead.

export type TopCustomerRow = { name: string; totalSpent: number; lastPurchaseAt: string | null };

export type CustomerInsights = {
  totalCustomers: number;
  newInRange: number;
  active30d: number;
  inactive: number; // no purchase in 30+ days (or never)
  topCustomers: TopCustomerRow[];
};

export async function getCustomerInsights(
  start: string,
  end: string,
): Promise<CustomerInsights> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const [counts, top] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
                BETWEEN ${s}::date AND ${e}::date
        )::int AS new_in_range,
        COUNT(*) FILTER (
          WHERE last_purchase_at IS NOT NULL
            AND last_purchase_at >= NOW() - INTERVAL '30 days'
        )::int AS active_30d,
        COUNT(*) FILTER (
          WHERE last_purchase_at IS NULL
             OR last_purchase_at < NOW() - INTERVAL '30 days'
        )::int AS inactive
      FROM customers
      WHERE organization_id = ${orgId} AND deleted = false
    `),
    db.execute(sql`
      SELECT name, total_spent::float8 AS total_spent, last_purchase_at
      FROM customers
      WHERE organization_id = ${orgId} AND deleted = false
      ORDER BY total_spent DESC
      LIMIT 20
    `),
  ]);

  const c = (counts.rows?.[0] ?? {}) as Record<string, unknown>;

  return {
    totalCustomers: toInt(c.total),
    newInRange: toInt(c.new_in_range),
    active30d: toInt(c.active_30d),
    inactive: toInt(c.inactive),
    topCustomers: rows(top).map(r => ({
      name: String(r.name ?? ''),
      totalSpent: toNum(r.total_spent),
      lastPurchaseAt: r.last_purchase_at ? String(r.last_purchase_at) : null,
    })),
  };
}

// ── Inventory health ────────────────────────────────────────────────────────
// Turnover = COGS(last 30d) / current inventory value at cost. Dead stock =
// in-stock products with no sale in the last 30 days.

export type DeadStockRow = {
  name: string;
  stock: number;
  value: number;
  daysSinceLastSale: number | null;
};

export type InventoryHealth = {
  value: number;
  products: number;
  outOfStock: number;
  lowStock: number;
  overstock: number;
  cogs30d: number;
  turnover: number;
  daysOfInventory: number;
  deadStock: DeadStockRow[];
};

export async function getInventoryHealth(): Promise<InventoryHealth> {
  const { orgId } = await requireOrg();

  const [summary, cogs, dead] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(cost * stock), 0)::float8 AS value,
        COUNT(*)::int AS products,
        COUNT(*) FILTER (WHERE stock <= 0)::int AS out_of_stock,
        COUNT(*) FILTER (WHERE stock BETWEEN 1 AND min_stock)::int AS low_stock,
        COUNT(*) FILTER (
          WHERE stock_max_recommended IS NOT NULL
            AND stock > stock_max_recommended
        )::int AS overstock
      FROM products
      WHERE organization_id = ${orgId} AND deleted = false
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(ABS(qty) * COALESCE(unit_cost, 0)), 0)::float8 AS cogs
      FROM stock_movements
      WHERE organization_id = ${orgId}
        AND type = 'exit'
        AND sale_id IS NOT NULL
        AND created_at >= NOW() - INTERVAL '30 days'
    `),
    db.execute(sql`
      WITH last_sale AS (
        SELECT si.product_id, MAX(s.created_at) AS last_sold
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.organization_id = ${orgId} AND s.status = 'completed'
        GROUP BY si.product_id
      )
      SELECT
        p.name,
        p.stock,
        (p.cost * p.stock)::float8 AS value,
        EXTRACT(day FROM NOW() - ls.last_sold)::int AS days_since
      FROM products p
      LEFT JOIN last_sale ls ON ls.product_id = p.id
      WHERE p.organization_id = ${orgId}
        AND p.deleted = false
        AND p.stock > 0
        AND (ls.last_sold IS NULL OR ls.last_sold < NOW() - INTERVAL '30 days')
      ORDER BY value DESC
      LIMIT 30
    `),
  ]);

  const sm = (summary.rows?.[0] ?? {}) as Record<string, unknown>;
  const cg = (cogs.rows?.[0] ?? {}) as Record<string, unknown>;
  const value = toNum(sm.value);
  const cogs30d = toNum(cg.cogs);
  const turnover = value > 0 ? cogs30d / value : 0;

  return {
    value,
    products: toInt(sm.products),
    outOfStock: toInt(sm.out_of_stock),
    lowStock: toInt(sm.low_stock),
    overstock: toInt(sm.overstock),
    cogs30d,
    turnover,
    daysOfInventory: turnover > 0 ? 30 / turnover : 0,
    deadStock: rows(dead).map(r => ({
      name: String(r.name ?? ''),
      stock: toInt(r.stock),
      value: toNum(r.value),
      daysSinceLastSale: r.days_since === null ? null : toInt(r.days_since),
    })),
  };
}

// ── Fiados aging ──────────────────────────────────────────────────────────

export type FiadoAgingBucket = { bucket: string; count: number; amount: number };

export async function getFiadosAging(): Promise<FiadoAgingBucket[]> {
  const { orgId } = await requireOrg();

  const result = await db.execute(sql`
    WITH fiado_debt AS (
      SELECT
        s.id,
        s.total::numeric AS total,
        COALESCE((
          SELECT SUM(sp.amount) FROM sale_payments sp
          WHERE sp.sale_id = s.id AND sp.method NOT ILIKE '%fiado%'
        ), 0)::numeric AS paid,
        EXTRACT(day FROM NOW() - s.created_at)::int AS age_days
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
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN age_days <= 3 THEN '0-3 días'
          WHEN age_days <= 7 THEN '4-7 días'
          WHEN age_days <= 15 THEN '8-15 días'
          ELSE '15+ días'
        END AS bucket,
        (total - paid)::float8 AS owed
      FROM fiado_debt
      WHERE total - paid > 0
    )
    SELECT bucket, COUNT(*)::int AS count, COALESCE(SUM(owed), 0)::float8 AS amount
    FROM bucketed
    GROUP BY bucket
  `);

  const order = ['0-3 días', '4-7 días', '8-15 días', '15+ días'];
  const map = new Map(
    rows(result).map(r => [
      String(r.bucket),
      { count: toInt(r.count), amount: toNum(r.amount) },
    ]),
  );
  return order.map(bucket => ({
    bucket,
    count: map.get(bucket)?.count ?? 0,
    amount: map.get(bucket)?.amount ?? 0,
  }));
}

// ── Expiration risk (Smart Stock) ───────────────────────────────────────────

export type ExpirationTierRow = { tier: string; count: number; value: number };
export type SuggestionStatusRow = { status: string; count: number };

export type ExpirationReport = {
  totalAtRisk: number;
  byTier: ExpirationTierRow[];
  suggestions: SuggestionStatusRow[];
};

export async function getExpirationRisk(): Promise<ExpirationReport> {
  const { orgId } = await requireOrg();

  const [tiers, suggestions] = await Promise.all([
    db.execute(sql`
      SELECT
        payload->>'tier' AS tier,
        COUNT(*)::int AS count,
        COALESCE(SUM(
          COALESCE((payload->>'remainingQty')::numeric, 0)
          * COALESCE((payload->>'unitCost')::numeric, 0)
        ), 0)::float8 AS value
      FROM expiration_risk_cache
      WHERE organization_id = ${orgId}
        AND payload->>'tier' IS NOT NULL
      GROUP BY payload->>'tier'
    `),
    db.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM expiration_suggestions
      WHERE organization_id = ${orgId}
      GROUP BY status
    `),
  ]);

  const tierOrder = ['atencion', 'urgente', 'critico'];
  const tierMap = new Map(
    rows(tiers).map(r => [
      String(r.tier),
      { count: toInt(r.count), value: toNum(r.value) },
    ]),
  );
  const byTier = tierOrder
    .filter(t => tierMap.has(t))
    .map(tier => ({
      tier,
      count: tierMap.get(tier)!.count,
      value: tierMap.get(tier)!.value,
    }));

  return {
    totalAtRisk: byTier.reduce((acc, t) => acc + t.value, 0),
    byTier,
    suggestions: rows(suggestions).map(r => ({
      status: String(r.status ?? ''),
      count: toInt(r.count),
    })),
  };
}

// ── Margin by category ──────────────────────────────────────────────────────

export type CategoryMarginRow = {
  category: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
};

export async function getMarginByCategory(
  start: string,
  end: string,
): Promise<CategoryMarginRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    WITH sales_in_range AS (
      SELECT id FROM sales
      WHERE organization_id = ${orgId}
        AND status = 'completed'
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
    ),
    revenue AS (
      SELECT
        COALESCE(p.category, 'Sin categoría') AS category,
        SUM(si.subtotal)::numeric AS revenue
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id IN (SELECT id FROM sales_in_range)
      GROUP BY p.category
    ),
    cost AS (
      SELECT
        COALESCE(p.category, 'Sin categoría') AS category,
        SUM(ABS(sm.qty) * COALESCE(sm.unit_cost, 0))::numeric AS cost
      FROM stock_movements sm
      JOIN products p ON p.id = sm.product_id
      WHERE sm.type = 'exit'
        AND sm.sale_id IN (SELECT id FROM sales_in_range)
      GROUP BY p.category
    )
    SELECT
      r.category,
      r.revenue::float8 AS revenue,
      COALESCE(c.cost, 0)::float8 AS cost,
      (r.revenue - COALESCE(c.cost, 0))::float8 AS profit,
      CASE WHEN r.revenue > 0
        THEN ((r.revenue - COALESCE(c.cost, 0)) / r.revenue * 100)::float8
        ELSE 0
      END AS margin
    FROM revenue r
    LEFT JOIN cost c ON c.category = r.category
    ORDER BY revenue DESC
  `);

  return rows(result).map(r => ({
    category: String(r.category ?? 'Sin categoría'),
    revenue: toNum(r.revenue),
    cost: toNum(r.cost),
    profit: toNum(r.profit),
    margin: toNum(r.margin),
  }));
}

// ── Sales by weekday ─────────────────────────────────────────────────────────

export type WeekdayRow = { weekday: number; label: string; count: number; total: number };

const WEEKDAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export async function getSalesByWeekday(
  start: string,
  end: string,
): Promise<WeekdayRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    SELECT
      EXTRACT(dow FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota'))::int AS weekday,
      COUNT(*)::int AS count,
      COALESCE(SUM(total), 0)::float8 AS total
    FROM sales
    WHERE organization_id = ${orgId}
      AND status = 'completed'
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${s}::date AND ${e}::date
    GROUP BY weekday
  `);

  const map = new Map(
    rows(result).map(r => [
      toInt(r.weekday),
      { count: toInt(r.count), total: toNum(r.total) },
    ]),
  );
  return WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    count: map.get(weekday)?.count ?? 0,
    total: map.get(weekday)?.total ?? 0,
  }));
}
