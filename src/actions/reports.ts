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

// ── 1. Ventas por período ──────────────────────────────────────────────────

export type SalesByPeriodRow = {
  day: string;
  total: number;
  count: number;
  avgTicket: number;
  profit: number;
  margin: number;
};

export async function getSalesByPeriod(
  start: string,
  end: string,
): Promise<SalesByPeriodRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    WITH daily AS (
      SELECT
        to_char((s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS day,
        s.id,
        s.total::numeric AS total
      FROM sales s
      WHERE s.organization_id = ${orgId}
        AND s.status = 'completed'
        AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
    ),
    costs AS (
      SELECT si.sale_id, SUM(si.qty * p.cost) AS cost
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      WHERE si.sale_id IN (SELECT id FROM daily)
      GROUP BY si.sale_id
    )
    SELECT
      d.day,
      COALESCE(SUM(d.total), 0)::float8 AS total,
      COUNT(d.id)::int AS count,
      COALESCE(AVG(d.total), 0)::float8 AS avg_ticket,
      COALESCE(SUM(d.total - COALESCE(c.cost, 0)), 0)::float8 AS profit,
      CASE
        WHEN COALESCE(SUM(d.total), 0) > 0
          THEN (SUM(d.total - COALESCE(c.cost, 0)) / SUM(d.total) * 100)::float8
        ELSE 0
      END AS margin
    FROM daily d
    LEFT JOIN costs c ON c.sale_id = d.id
    GROUP BY d.day
    ORDER BY d.day
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      day: String(row.day ?? ''),
      total: toNum(row.total),
      count: toInt(row.count),
      avgTicket: toNum(row.avg_ticket),
      profit: toNum(row.profit),
      margin: toNum(row.margin),
    };
  });
}

// ── 2. Ventas por cajero ───────────────────────────────────────────────────

export type SalesByCashierRow = {
  cashierId: string;
  cashierName: string;
  count: number;
  total: number;
  avgTicket: number;
};

export async function getSalesByCashier(
  start: string,
  end: string,
): Promise<SalesByCashierRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    SELECT
      s.cashier_id,
      COALESCE(pu.name, s.cashier_id) AS cashier_name,
      COUNT(*)::int AS count,
      SUM(s.total)::float8 AS total,
      AVG(s.total)::float8 AS avg_ticket
    FROM sales s
    LEFT JOIN pos_users pu ON pu.id::text = s.cashier_id
    WHERE s.organization_id = ${orgId}
      AND s.status = 'completed'
      AND s.cashier_id IS NOT NULL
      AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${s}::date AND ${e}::date
    GROUP BY s.cashier_id, pu.name
    ORDER BY total DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      cashierId: String(row.cashier_id ?? ''),
      cashierName: String(row.cashier_name ?? ''),
      count: toInt(row.count),
      total: toNum(row.total),
      avgTicket: toNum(row.avg_ticket),
    };
  });
}

// ── 3. Ventas por método de pago ───────────────────────────────────────────

export type SalesByPaymentRow = {
  method: string;
  count: number;
  total: number;
  pct: number;
};

export async function getSalesByPayment(
  start: string,
  end: string,
): Promise<SalesByPaymentRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    WITH totals AS (
      SELECT
        payment_type AS method,
        COUNT(*)::int AS count,
        SUM(total)::float8 AS total
      FROM sales
      WHERE organization_id = ${orgId}
        AND status = 'completed'
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
            BETWEEN ${s}::date AND ${e}::date
      GROUP BY payment_type
    ),
    grand AS (
      SELECT SUM(total) AS grand_total FROM totals
    )
    SELECT
      t.method,
      t.count,
      t.total,
      CASE WHEN g.grand_total > 0
        THEN (t.total / g.grand_total * 100)::float8
        ELSE 0
      END AS pct
    FROM totals t, grand g
    ORDER BY t.total DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      method: String(row.method ?? ''),
      count: toInt(row.count),
      total: toNum(row.total),
      pct: toNum(row.pct),
    };
  });
}

// ── 4. Top productos ───────────────────────────────────────────────────────

export type TopProductRow = {
  name: string;
  category: string;
  qty: number;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
};

export async function getTopProducts(
  start: string,
  end: string,
): Promise<TopProductRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    SELECT
      p.name,
      COALESCE(p.category, 'Sin categoría') AS category,
      SUM(si.qty)::int AS qty,
      SUM(si.subtotal)::float8 AS revenue,
      SUM(si.qty * p.cost)::float8 AS cost,
      SUM(si.subtotal - si.qty * p.cost)::float8 AS profit,
      CASE WHEN SUM(si.subtotal) > 0
        THEN ((SUM(si.subtotal - si.qty * p.cost)) / SUM(si.subtotal) * 100)::float8
        ELSE 0
      END AS margin
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.organization_id = ${orgId}
      AND s.status = 'completed'
      AND (s.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${s}::date AND ${e}::date
    GROUP BY p.id, p.name, p.category
    ORDER BY revenue DESC
    LIMIT 50
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      name: String(row.name ?? ''),
      category: String(row.category ?? ''),
      qty: toInt(row.qty),
      revenue: toNum(row.revenue),
      cost: toNum(row.cost),
      profit: toNum(row.profit),
      margin: toNum(row.margin),
    };
  });
}

// ── 5. Análisis de caja ────────────────────────────────────────────────────

export type CashAnalysisRow = {
  id: string;
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string;
  openingAmount: number;
  expectedAmount: number;
  countedAmount: number;
  difference: number;
  hasFraudAlert: boolean;
};

export async function getCashAnalysis(
  start: string,
  end: string,
): Promise<CashAnalysisRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    SELECT
      cs.id::text,
      cs.opened_at,
      cs.closed_at,
      COALESCE(opu.name, cs.opened_by) AS opened_by_name,
      COALESCE(cpu.name, cs.closed_by, '') AS closed_by_name,
      cs.opening_amount::float8 AS opening_amount,
      COALESCE(cs.expected_amount, 0)::float8 AS expected_amount,
      COALESCE(cs.counted_amount, 0)::float8 AS counted_amount,
      COALESCE(cs.difference, 0)::float8 AS difference,
      CASE WHEN ABS(COALESCE(cs.difference, 0)) > 5000 THEN true ELSE false END AS has_fraud_alert
    FROM cash_sessions cs
    LEFT JOIN pos_users opu ON opu.id::text = cs.opened_by
    LEFT JOIN pos_users cpu ON cpu.id::text = cs.closed_by
    WHERE cs.organization_id = ${orgId}
      AND cs.status = 'closed'
      AND (cs.closed_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${s}::date AND ${e}::date
    ORDER BY cs.closed_at DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id ?? ''),
      openedAt: String(row.opened_at ?? ''),
      closedAt: String(row.closed_at ?? ''),
      openedBy: String(row.opened_by_name ?? ''),
      closedBy: String(row.closed_by_name ?? ''),
      openingAmount: toNum(row.opening_amount),
      expectedAmount: toNum(row.expected_amount),
      countedAmount: toNum(row.counted_amount),
      difference: toNum(row.difference),
      hasFraudAlert: Boolean(row.has_fraud_alert),
    };
  });
}

// ── 6. Inventario valorizado ───────────────────────────────────────────────

export type InventoryRow = {
  category: string;
  productCount: number;
  totalValue: number;
  outOfStock: number;
  lowStock: number;
};

export async function getInventoryValuation(): Promise<InventoryRow[]> {
  const { orgId } = await requireOrg();

  const result = await db.execute(sql`
    SELECT
      COALESCE(category, 'Sin categoría') AS category,
      COUNT(*)::int AS product_count,
      COALESCE(SUM(cost * stock), 0)::float8 AS total_value,
      COUNT(*) FILTER (WHERE stock <= 0)::int AS out_of_stock,
      COUNT(*) FILTER (WHERE stock BETWEEN 1 AND min_stock)::int AS low_stock
    FROM products
    WHERE organization_id = ${orgId}
      AND deleted = false
    GROUP BY category
    ORDER BY total_value DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      category: String(row.category ?? ''),
      productCount: toInt(row.product_count),
      totalValue: toNum(row.total_value),
      outOfStock: toInt(row.out_of_stock),
      lowStock: toInt(row.low_stock),
    };
  });
}

// ── 7. Fiados pendientes ───────────────────────────────────────────────────

export type FiadoReportRow = {
  clientName: string;
  saleCount: number;
  totalOwed: number;
  oldestDays: number;
  risk: string;
};

export async function getFiadoReport(): Promise<FiadoReportRow[]> {
  const { orgId } = await requireOrg();

  const result = await db.execute(sql`
    WITH fiado_sales AS (
      SELECT
        s.id,
        s.total::numeric AS total,
        s.notes,
        s.created_at,
        COALESCE(
          (SELECT SUM(sp.amount) FROM sale_payments sp
           WHERE sp.sale_id = s.id AND sp.method NOT ILIKE '%fiado%'),
          0
        )::numeric AS paid
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
    SELECT
      COALESCE(
        substring(notes FROM '(?:Cliente|Nombre):\s*([^|]+)'),
        'Sin nombre'
      ) AS client_name,
      COUNT(*)::int AS sale_count,
      SUM(total - paid)::float8 AS total_owed,
      MAX(EXTRACT(day FROM NOW() - created_at))::int AS oldest_days,
      CASE
        WHEN MAX(EXTRACT(day FROM NOW() - created_at)) >= 7 THEN 'alto'
        WHEN MAX(EXTRACT(day FROM NOW() - created_at)) >= 3 THEN 'medio'
        ELSE 'bajo'
      END AS risk
    FROM fiado_sales
    WHERE total - paid > 0
    GROUP BY client_name
    ORDER BY total_owed DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      clientName: String(row.client_name ?? 'Sin nombre'),
      saleCount: toInt(row.sale_count),
      totalOwed: toNum(row.total_owed),
      oldestDays: toInt(row.oldest_days),
      risk: String(row.risk ?? 'bajo'),
    };
  });
}

// ── 8. Pérdidas (mermas) ───────────────────────────────────────────────────

export type LossRow = {
  productName: string;
  reason: string;
  qty: number;
  unitCost: number;
  totalLoss: number;
  date: string;
};

export async function getLossReport(
  start: string,
  end: string,
): Promise<LossRow[]> {
  const { orgId } = await requireOrg();
  const s = validateDate(start, 'start');
  const e = validateDate(end, 'end');

  const result = await db.execute(sql`
    SELECT
      COALESCE(sm.product_name, p.name, 'Producto eliminado') AS product_name,
      COALESCE(sm.reason, 'sin razón') AS reason,
      ABS(sm.qty)::int AS qty,
      COALESCE(sm.unit_cost, p.cost, 0)::float8 AS unit_cost,
      (ABS(sm.qty) * COALESCE(sm.unit_cost, p.cost, 0))::float8 AS total_loss,
      to_char((sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS date
    FROM stock_movements sm
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE sm.organization_id = ${orgId}
      AND sm.type = 'exit'
      AND LOWER(COALESCE(sm.reason, '')) IN ('spoiled', 'damaged', 'lost', 'vencido', 'dañado', 'perdido')
      AND (sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date
          BETWEEN ${s}::date AND ${e}::date
    ORDER BY sm.created_at DESC
  `);

  return (result.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      productName: String(row.product_name ?? ''),
      reason: String(row.reason ?? ''),
      qty: toInt(row.qty),
      unitCost: toNum(row.unit_cost),
      totalLoss: toNum(row.total_loss),
      date: String(row.date ?? ''),
    };
  });
}
