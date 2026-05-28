'use server';

import type { SQL } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/db-context';
import {
  productsSchema,
  saleItemsSchema,
  salesSchema,
  stockMovementsSchema,
} from '@/models/Schema';

async function requireUser() {
  const { userId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  return { userId };
}

// ── Types ────────────────────────────────────────────────────────────────

export type MovementType = 'entry' | 'exit' | 'adjustment';

export type MovementReason
  = | 'purchase'
    | 'sale'
    | 'return_sale'
    | 'spoiled'
    | 'damaged'
    | 'lost'
    | 'manual'
    | 'inventory_count';

export type RecordMovementInput = {
  productId: string;
  type: MovementType;
  qty: number;
  reason: MovementReason;
  unitCost?: string | null;
  supplierId?: string | null;
  expiresAt?: string | null;
  saleId?: string | null;
  notes?: string | null;
};

export type StockMovement = typeof stockMovementsSchema.$inferSelect;

// ── recordMovement ───────────────────────────────────────────────────────

export async function recordMovement(input: RecordMovementInput) {
  const { userId } = await requireUser();
  const tdb = await db();

  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new Error('qty must be a positive number');
  }

  const [product] = await tdb
    .select({ id: productsSchema.id, name: productsSchema.name, stock: productsSchema.stock })
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.id, input.productId),
        eq(productsSchema.deleted, false),
      ),
    )
    .limit(1);

  if (!product) {
    throw new Error('Product not found');
  }

  const result = await tdb.transaction(async (tx) => {
    const [movement] = await tx
      .insert(stockMovementsSchema)
      .values({
        productId: input.productId,
        productName: product.name,
        type: input.type,
        qty: input.qty,
        remainingQty: input.type === 'entry' ? input.qty : null,
        reason: input.reason,
        unitCost: input.unitCost ?? null,
        expiresAt: input.expiresAt ?? null,
        saleId: input.saleId ?? null,
        supplierId: input.supplierId ?? null,
        createdBy: userId,
      })
      .returning();

    let stockUpdate: Record<string, unknown>;
    if (input.type === 'entry') {
      stockUpdate = { stock: sql`${productsSchema.stock} + ${input.qty}` };
    } else if (input.type === 'exit') {
      stockUpdate = { stock: sql`GREATEST(0, ${productsSchema.stock} - ${input.qty})` };
    } else {
      stockUpdate = { stock: input.qty };
    }

    const [updated] = await tx
      .update(productsSchema)
      .set(stockUpdate)
      .where(eq(productsSchema.id, input.productId))
      .returning();

    return { movement, product: updated };
  });

  revalidatePath('/dashboard/inventory');
  return result;
}

// ── listMovements ────────────────────────────────────────────────────────

export type ListMovementsParams = {
  productId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export async function listMovements(params?: ListMovementsParams) {
  await requireUser();
  const tdb = await db();
  const page = params?.page ?? 1;
  const pageSize = params?.pageSize ?? 50;

  const filters: SQL[] = [];
  if (params?.productId) {
    filters.push(eq(stockMovementsSchema.productId, params.productId));
  }
  if (params?.from) {
    filters.push(gte(stockMovementsSchema.createdAt, new Date(params.from)));
  }
  if (params?.to) {
    filters.push(lte(stockMovementsSchema.createdAt, new Date(params.to)));
  }

  const base = tdb
    .select({
      id: stockMovementsSchema.id,
      organizationId: stockMovementsSchema.organizationId,
      productId: stockMovementsSchema.productId,
      snapshotName: stockMovementsSchema.productName,
      currentName: productsSchema.name,
      type: stockMovementsSchema.type,
      qty: stockMovementsSchema.qty,
      remainingQty: stockMovementsSchema.remainingQty,
      unitCost: stockMovementsSchema.unitCost,
      expiresAt: stockMovementsSchema.expiresAt,
      reason: stockMovementsSchema.reason,
      createdBy: stockMovementsSchema.createdBy,
      saleId: stockMovementsSchema.saleId,
      supplierId: stockMovementsSchema.supplierId,
      createdAt: stockMovementsSchema.createdAt,
    })
    .from(stockMovementsSchema)
    .leftJoin(productsSchema, eq(productsSchema.id, stockMovementsSchema.productId))
    .$dynamic();

  const q = filters.length > 0 ? base.where(and(...filters)) : base;

  return q
    .orderBy(desc(stockMovementsSchema.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
}

// ── getInventoryProducts ─────────────────────────────────────────────────

export type InventoryProduct = {
  id: string;
  name: string;
  stock: number;
  minStock: number;
  stockMaxRecommended: number | null;
  cost: string;
  price: string;
  category: string | null;
  unitType: 'unit' | 'kg';
  isPerishable: boolean;
  status: 'ok' | 'low' | 'critical';
};

export async function getInventoryProducts(): Promise<InventoryProduct[]> {
  await requireUser();
  const tdb = await db();

  const rows = await tdb
    .select()
    .from(productsSchema)
    .where(eq(productsSchema.deleted, false))
    .orderBy(productsSchema.name);

  return rows.map((r) => {
    let status: 'ok' | 'low' | 'critical' = 'ok';
    if (r.minStock > 0 && r.stock <= 0) {
      status = 'critical';
    } else if (r.minStock > 0 && r.stock <= r.minStock) {
      status = 'low';
    }

    return {
      id: r.id,
      name: r.name,
      stock: r.stock,
      minStock: r.minStock,
      stockMaxRecommended: r.stockMaxRecommended,
      cost: r.cost,
      price: r.price,
      category: r.category,
      unitType: r.unitType,
      isPerishable: r.isPerishable,
      status,
    };
  });
}

// ── getSmartStockSuggestion ──────────────────────────────────────────────
// Basic recommendation based on 30-day sales velocity.

export type SmartStockSuggestion = {
  productId: string;
  avgDailySales: number;
  suggestedMinStock: number;
  suggestedLeadTimeDays: number;
  suggestedMaxStock: number;
  reasoning: string;
};

export async function getSmartStockSuggestion(
  productId: string,
): Promise<SmartStockSuggestion> {
  await requireUser();
  const tdb = await db();

  const [product] = await tdb
    .select()
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.id, productId),
        eq(productsSchema.deleted, false),
      ),
    )
    .limit(1);

  if (!product) {
    throw new Error('Product not found');
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);

  // sale_items has no organization_id of its own — we JOIN through `sales`
  // (a tenant table) so the proxy's filter on the parent enforces isolation.
  const [salesAgg] = await tdb
    .select({
      totalQty: sql<string>`COALESCE(SUM(${saleItemsSchema.qty}), 0)`,
      totalSales: sql<string>`COUNT(DISTINCT ${salesSchema.id})`,
    })
    .from(salesSchema)
    .innerJoin(saleItemsSchema, eq(saleItemsSchema.saleId, salesSchema.id))
    .where(
      and(
        eq(saleItemsSchema.productId, productId),
        gte(salesSchema.createdAt, since),
      ),
    );

  const totalQty = Number(salesAgg?.totalQty ?? 0);
  const avgDaily = totalQty / 30;

  const leadTimeDays = 3;
  const safetyFactor = 1.5;
  const suggestedMinStock = Math.ceil(avgDaily * leadTimeDays * safetyFactor);
  const suggestedMaxStock = Math.ceil(avgDaily * leadTimeDays * 3);

  let reasoning: string;
  if (avgDaily === 0) {
    reasoning = `Sin ventas en los últimos 30 días. Se recomienda un stock mínimo de seguridad de ${suggestedMinStock} unidades.`;
  } else {
    reasoning = `Vendes ~${avgDaily.toFixed(1)} unidades/día (${totalQty} en 30 días). `
      + `Con un lead time de ${leadTimeDays} días y factor de seguridad ×${safetyFactor}, `
      + `el mínimo sugerido es ${suggestedMinStock}. `
      + `Stock máximo recomendado: ${suggestedMaxStock} (≈${(suggestedMaxStock / avgDaily).toFixed(0)} días de inventario).`;
  }

  return {
    productId,
    avgDailySales: Math.round(avgDaily * 10) / 10,
    suggestedMinStock,
    suggestedLeadTimeDays: leadTimeDays,
    suggestedMaxStock,
    reasoning,
  };
}
