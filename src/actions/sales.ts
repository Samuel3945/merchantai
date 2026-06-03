'use server';

import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { recordCashMovement } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { consumeFifoExits } from '@/libs/fifo-cogs';
import {
  posTokensSchema,
  productsSchema,
  saleItemsSchema,
  salePaymentsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

export type SalePaymentInput = {
  method: string;
  amount: number | string;
  reference?: string | null;
  billsPaid?: unknown;
  changeGiven?: number | string;
};

export type CreateSaleInput = {
  items: { productId: string; qty: number }[];
  paymentType: string;
  notes?: string | null;
  payments?: SalePaymentInput[];
};

function toMoney(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) {
    throw new TypeError('Invalid monetary value');
  }
  return n.toFixed(2);
}

export async function createSale(input: CreateSaleInput) {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  if (!input.items || input.items.length === 0) {
    throw new Error('Sale must include at least one item');
  }

  for (const item of input.items) {
    if (!item.productId) {
      throw new Error('Each item must include a productId');
    }
    if (!Number.isFinite(item.qty) || item.qty <= 0) {
      throw new Error('Each item must have qty > 0');
    }
  }

  const result = await db.transaction(async (tx) => {
    let total = 0;
    const itemsToInsert: {
      productId: string;
      productName: string;
      qty: number;
      price: string;
      subtotal: string;
      unitType: string;
    }[] = [];
    // Reference cost per line (products.cost), used as a fallback when the FIFO
    // ledger doesn't fully cover the sold quantity (e.g. legacy stock with no
    // entry batches). Aligned by index with itemsToInsert.
    const lineFallbackCost: string[] = [];

    for (const item of input.items) {
      const [product] = await tx
        .select()
        .from(productsSchema)
        .where(
          and(
            eq(productsSchema.id, item.productId),
            eq(productsSchema.organizationId, orgId),
            eq(productsSchema.deleted, false),
          ),
        )
        .for('update')
        .limit(1);

      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }

      if (product.stock < item.qty) {
        throw new Error(
          `Insufficient stock for "${product.name}" (available: ${product.stock}, requested: ${item.qty})`,
        );
      }

      const unitPrice = Number.parseFloat(product.price);
      if (!Number.isFinite(unitPrice)) {
        throw new TypeError(`Invalid price for product ${product.id}`);
      }
      const subtotal = unitPrice * item.qty;
      total += subtotal;

      itemsToInsert.push({
        productId: product.id,
        productName: product.name,
        qty: item.qty,
        price: toMoney(unitPrice),
        subtotal: toMoney(subtotal),
        unitType: product.unitType,
      });
      lineFallbackCost.push(product.cost);
    }

    const totalStr = toMoney(total);

    const [sale] = await tx
      .insert(salesSchema)
      .values({
        organizationId: orgId,
        total: totalStr,
        paymentType: input.paymentType,
        status: 'completed',
        notes: input.notes ?? null,
        cashierId: userId,
      })
      .returning();

    if (!sale) {
      throw new Error('Failed to create sale');
    }

    const insertedItems = await tx
      .insert(saleItemsSchema)
      .values(itemsToInsert.map(it => ({ saleId: sale.id, ...it })))
      .returning();

    // FIFO consumption + exit cost capture, shared by every sale path.
    const exitRows = await consumeFifoExits(
      tx,
      orgId,
      userId,
      sale.id,
      itemsToInsert.map((it, i) => ({
        productId: it.productId,
        productName: it.productName,
        qty: it.qty,
        fallbackCost: lineFallbackCost[i] ?? '0',
      })),
    );

    // Stock on hand stays the authoritative quantity; the FIFO ledger above
    // mirrors it batch by batch.
    for (const item of input.items) {
      await tx
        .update(productsSchema)
        .set({
          stock: sql`GREATEST(0, ${productsSchema.stock} - ${item.qty})`,
        })
        .where(
          and(
            eq(productsSchema.id, item.productId),
            eq(productsSchema.organizationId, orgId),
          ),
        );
    }

    await tx.insert(stockMovementsSchema).values(exitRows);

    const paymentRows
      = input.payments && input.payments.length > 0
        ? input.payments.map(p => ({
            saleId: sale.id,
            method: p.method,
            amount: toMoney(p.amount),
            reference: p.reference ?? null,
            billsPaid: p.billsPaid ?? null,
            changeGiven:
              p.changeGiven !== undefined ? toMoney(p.changeGiven) : '0',
          }))
        : [
            {
              saleId: sale.id,
              method: input.paymentType,
              amount: totalStr,
              reference: null,
              billsPaid: null,
              changeGiven: '0',
            },
          ];

    const insertedPayments = await tx
      .insert(salePaymentsSchema)
      .values(paymentRows)
      .returning();

    return { ...sale, items: insertedItems, payments: insertedPayments };
  });

  await recordCashMovement(result.id, result.total);

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'sale.created',
    entityType: 'sale',
    entityId: result.id,
    after: {
      id: result.id,
      total: result.total,
      paymentType: result.paymentType,
      status: result.status,
      itemCount: result.items.length,
    },
    metadata: {
      paymentType: input.paymentType,
      payments: result.payments.map(p => ({
        method: p.method,
        amount: p.amount,
      })),
    },
  });

  revalidatePath('/dashboard/sales');
  revalidatePath('/dashboard/products');

  return result;
}

export type Sale = typeof salesSchema.$inferSelect;

export type ListSalesFilters = {
  limit?: number;
  offset?: number;
  start?: string | null;
  end?: string | null;
  payment?: string | null;
  search?: string | null;
  cashierId?: string | null;
};

export type ListSalesResult = {
  items: Sale[];
  total: number;
};

export async function listSales(
  filters: ListSalesFilters = {},
): Promise<ListSalesResult> {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const conds = [
    eq(salesSchema.organizationId, orgId),
    inArray(salesSchema.status, ['completed', 'settled'] as const),
  ];

  if (filters.start && filters.end) {
    conds.push(
      sql`(${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date BETWEEN ${filters.start}::date AND ${filters.end}::date`,
    );
  } else if (filters.start) {
    conds.push(
      sql`(${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date >= ${filters.start}::date`,
    );
  } else if (filters.end) {
    conds.push(
      sql`(${salesSchema.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date <= ${filters.end}::date`,
    );
  }

  const payment = filters.payment?.trim().toLowerCase();
  if (payment && payment !== 'all') {
    if (payment === 'efectivo') {
      const f = or(
        ilike(salesSchema.paymentType, '%efectivo%'),
        ilike(salesSchema.paymentType, '%cash%'),
      );
      if (f) {
        conds.push(f);
      }
    } else if (payment === 'transferencia') {
      const f = or(
        ilike(salesSchema.paymentType, '%transfer%'),
        ilike(salesSchema.paymentType, '%nequi%'),
        ilike(salesSchema.paymentType, '%daviplata%'),
        ilike(salesSchema.paymentType, '%banco%'),
      );
      if (f) {
        conds.push(f);
      }
    } else {
      conds.push(ilike(salesSchema.paymentType, `%${payment}%`));
    }
  }

  if (filters.cashierId && filters.cashierId.trim() !== '') {
    conds.push(eq(salesSchema.cashierId, filters.cashierId.trim()));
  }

  const search = filters.search?.trim();
  if (search) {
    const like = `%${search}%`;
    const f = or(
      sql`${salesSchema.id}::text ILIKE ${like}`,
      exists(
        db
          .select({ one: sql`1` })
          .from(saleItemsSchema)
          .where(
            and(
              eq(saleItemsSchema.saleId, salesSchema.id),
              ilike(saleItemsSchema.productName, like),
            ),
          ),
      ),
    );
    if (f) {
      conds.push(f);
    }
  }

  const whereClause = and(...conds);

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(salesSchema)
      .where(whereClause)
      .orderBy(desc(salesSchema.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(salesSchema)
      .where(whereClause),
  ]);

  return {
    items,
    total: totalRow[0]?.count ?? 0,
  };
}

// --- Caja saturation signal -------------------------------------------------
// "This register works a lot → buy/activate another caja" is measured by the
// REST between consecutive sales, not by raw daily volume. A tiny gap means the
// cashier never gets breathing room — the honest bottleneck signal, and it is
// auto-normalized across business types (a bakery and a supermarket each have
// their own comfortable rhythm; sales/day would need a different threshold per
// business, the inter-sale gap does not).
const SATURATION_WINDOW_DAYS = 30;
// Gaps longer than this are treated as "store closed / long pause" and excluded
// from the median, so an overnight gap can't inflate it and hide midday rush.
const SATURATION_CLOSED_GAP_SECONDS = 60 * 60; // 1h
// Median gap at or below this ⇒ the caja is saturated.
const SATURATION_MEDIAN_THRESHOLD_SECONDS = 2 * 60; // 2min
// Don't judge saturation on thin data — a median over a handful of sales lies.
const SATURATION_MIN_SALES = 20;

export type CajaSaturation = {
  posTokenId: string;
  deviceName: string | null;
  salesCount: number;
  medianGapSeconds: number | null;
  saturated: boolean;
};

export type SaturationReport = {
  // True when at least one caja is at its working limit.
  saturated: boolean;
  cajas: CajaSaturation[];
};

// Per-caja saturation over the trailing window. One SQL pass: LAG() yields the
// gap to the previous sale on the same caja, percentile_cont(0.5) the median of
// the gaps that fall under the closed-store cutoff, and the HAVING clause drops
// cajas with too few sales to judge.
export async function getCashierSaturation(): Promise<SaturationReport> {
  const { orgId } = await auth();
  if (!orgId) {
    throw new Error('No active organization');
  }

  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        ${salesSchema.posTokenId} AS pos_token_id,
        EXTRACT(EPOCH FROM (
          ${salesSchema.createdAt}
          - LAG(${salesSchema.createdAt}) OVER (
              PARTITION BY ${salesSchema.posTokenId}
              ORDER BY ${salesSchema.createdAt}
            )
        )) AS gap_seconds
      FROM ${salesSchema}
      WHERE ${salesSchema.organizationId} = ${orgId}
        AND ${salesSchema.status} IN ('completed', 'settled')
        AND ${salesSchema.posTokenId} IS NOT NULL
        AND ${salesSchema.createdAt}
            >= now() - make_interval(days => ${SATURATION_WINDOW_DAYS})
    )
    SELECT
      b.pos_token_id AS "posTokenId",
      t.device_name AS "deviceName",
      count(*)::int AS "salesCount",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY b.gap_seconds)
        FILTER (
          WHERE b.gap_seconds IS NOT NULL
            AND b.gap_seconds <= ${SATURATION_CLOSED_GAP_SECONDS}
        ) AS "medianGapSeconds"
    FROM base b
    LEFT JOIN ${posTokensSchema} t ON t.id = b.pos_token_id
    GROUP BY b.pos_token_id, t.device_name
    HAVING count(*) >= ${SATURATION_MIN_SALES}
  `);

  const rows = result.rows as Array<{
    posTokenId: string;
    deviceName: string | null;
    salesCount: number | string;
    medianGapSeconds: number | string | null;
  }>;

  const cajas: CajaSaturation[] = rows.map((row) => {
    const median
      = row.medianGapSeconds == null ? null : Number(row.medianGapSeconds);
    return {
      posTokenId: row.posTokenId,
      deviceName: row.deviceName,
      salesCount: Number(row.salesCount),
      medianGapSeconds: median,
      saturated:
        median != null && median <= SATURATION_MEDIAN_THRESHOLD_SECONDS,
    };
  });

  return {
    saturated: cajas.some(c => c.saturated),
    cajas,
  };
}
