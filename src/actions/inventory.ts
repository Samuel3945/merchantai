'use server';

import type { SQL } from 'drizzle-orm';
import type { SmartStockSettings } from '@/actions/smart-stock';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { and, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/db-context';
import { fifoBatchOrder } from '@/libs/fifo-cogs';
import {
  expirationRiskCacheSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
  stockMovementsSchema,
  suppliersSchema,
} from '@/models/Schema';

async function requireUser() {
  const { userId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  return { userId };
}

// ── Types ────────────────────────────────────────────────────────────────

// 'adjustment' is retained ONLY so historical rows still type-check when read.
// No flow in the redesigned inventory ever WRITES an adjustment — those set
// product.stock to an absolute value and desynced the FIFO ledger's
// remaining_qty. Physical-count differences now flow through entry/exit so
// products.stock always equals SUM(remaining_qty).
export type MovementType = 'entry' | 'exit' | 'adjustment';

export type MovementReason
  = | 'purchase'
    | 'sale'
    | 'return_sale'
    | 'spoiled' // legacy synonym of 'expired' — kept for history reads
    | 'damaged'
    | 'expired'
    | 'lost'
    | 'consumption'
    | 'return_supplier'
    | 'manual'
    | 'inventory_count'; // legacy — no new flow writes it

// Only entry/exit can be recorded from inventory. Adjustment is intentionally
// excluded from the input union so the absolute-stock path can't be reached.
export type RecordMovementInput = {
  productId: string;
  type: 'entry' | 'exit';
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
  const orgId = tdb.orgId;

  // Defense in depth: the type union forbids it, but a stray runtime caller
  // must never reach the absolute-stock path that desyncs the FIFO ledger.
  if (input.type !== 'entry' && input.type !== 'exit') {
    throw new Error('Only entry and exit movements can be recorded');
  }

  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new Error('qty must be a positive number');
  }

  // "Otro motivo" (manual) demands an explanation — server-side guard so the
  // movement is never written without one, regardless of the client.
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  if (input.reason === 'manual' && !notes) {
    throw new Error('El motivo "Otro" requiere una descripción');
  }

  const [product] = await tdb
    .select({
      id: productsSchema.id,
      name: productsSchema.name,
      stock: productsSchema.stock,
      cost: productsSchema.cost,
    })
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
    // Manual exits draw down the FIFO ledger (oldest batches first) and capture
    // the weighted cost of the units removed, mirroring how sales consume stock,
    // so loss valuation stays accurate and remaining_qty stays in sync. An
    // explicitly provided unitCost wins; otherwise we use the FIFO cost.
    let unitCost = input.unitCost ?? null;
    if (input.type === 'exit') {
      const batches = await tx
        .select({
          id: stockMovementsSchema.id,
          remainingQty: stockMovementsSchema.remainingQty,
          unitCost: stockMovementsSchema.unitCost,
        })
        .from(stockMovementsSchema)
        .where(
          and(
            eq(stockMovementsSchema.productId, input.productId),
            eq(stockMovementsSchema.type, 'entry'),
            gt(stockMovementsSchema.remainingQty, 0),
          ),
        )
        .orderBy(fifoBatchOrder)
        .for('update');

      const fallback = Number(product.cost) || 0;
      let remaining = input.qty;
      let totalCost = 0;
      for (const b of batches) {
        if (remaining <= 0) {
          break;
        }
        const take = Math.min(b.remainingQty ?? 0, remaining);
        totalCost += take * (b.unitCost != null ? Number(b.unitCost) : fallback);
        remaining -= take;
        await tx
          .update(stockMovementsSchema)
          .set({
            remainingQty: sql`${stockMovementsSchema.remainingQty} - ${take}`,
          })
          .where(eq(stockMovementsSchema.id, b.id));
      }
      // Units not covered by the ledger fall back to the product's reference cost.
      if (remaining > 0) {
        totalCost += remaining * fallback;
      }
      unitCost
        = input.unitCost
          ?? (input.qty > 0 ? (totalCost / input.qty).toFixed(2) : '0');
    }

    const [movement] = await tx
      .insert(stockMovementsSchema)
      .values({
        productId: input.productId,
        productName: product.name,
        type: input.type,
        qty: input.qty,
        remainingQty: input.type === 'entry' ? input.qty : null,
        reason: input.reason,
        unitCost,
        expiresAt: input.expiresAt ?? null,
        saleId: input.saleId ?? null,
        supplierId: input.supplierId ?? null,
        notes,
        createdBy: userId,
      })
      .returning();

    // entry adds units; exit removes them (floored at zero). We never SET stock
    // to an absolute value — that is the adjustment path we deliberately killed.
    const stockUpdate
      = input.type === 'entry'
        ? { stock: sql`${productsSchema.stock} + ${input.qty}` }
        : { stock: sql`GREATEST(0, ${productsSchema.stock} - ${input.qty})` };

    const [updated] = await tx
      .update(productsSchema)
      .set(stockUpdate)
      .where(eq(productsSchema.id, input.productId))
      .returning();

    return { movement, product: updated, stockBefore: product.stock };
  });

  // Audit trail: who moved what, and how stock changed. logAction swallows its
  // own errors so a failed audit write never rolls back the movement.
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: `inventory.${input.type}`,
    entityType: 'stock_movement',
    entityId: (result.movement?.id as string | undefined) ?? null,
    before: { stock: result.stockBefore },
    after: { stock: result.product?.stock ?? null },
    metadata: {
      productId: input.productId,
      productName: product.name,
      qty: input.qty,
      reason: input.reason,
      unitCost: result.movement?.unitCost ?? null,
      supplierId: input.supplierId ?? null,
      notes,
    },
  });

  revalidatePath('/dashboard/inventory');
  return result;
}

// ── updateMinStock ───────────────────────────────────────────────────────
// Manual edit of the reorder point. Refused while Smart Stock manages the
// minimum (Pro + flag on) — the column is read-only in that state.

export async function updateMinStock(productId: string, minStock: number) {
  const { userId } = await requireUser();
  const tdb = await db();
  const orgId = tdb.orgId;

  const settings = await getSmartStockSettings();
  if (settings.enabled) {
    throw new Error(
      'El stock mínimo lo gestiona Smart Stock (IA). Apagalo para editarlo a mano.',
    );
  }

  if (!Number.isInteger(minStock) || minStock < 0) {
    throw new Error('El stock mínimo debe ser un entero ≥ 0');
  }

  const [before] = await tdb
    .select({ minStock: productsSchema.minStock })
    .from(productsSchema)
    .where(
      and(eq(productsSchema.id, productId), eq(productsSchema.deleted, false)),
    )
    .limit(1);

  if (!before) {
    throw new Error('Product not found');
  }

  const [updated] = await tdb
    .update(productsSchema)
    .set({ minStock })
    .where(eq(productsSchema.id, productId))
    .returning({ id: productsSchema.id, minStock: productsSchema.minStock });

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'inventory.min_stock.update',
    entityType: 'product',
    entityId: productId,
    before: { minStock: before.minStock },
    after: { minStock: updated?.minStock ?? minStock },
  });

  revalidatePath('/dashboard/inventory');
  return { productId, minStock: updated?.minStock ?? minStock };
}

// ── getProductLots (FIFO ledger detail) ──────────────────────────────────

export type ProductLot = {
  id: string;
  remainingQty: number;
  qty: number;
  unitCost: string | null;
  expiresAt: string | null;
  createdAt: string;
  reason: string | null;
  supplierId: string | null;
  supplierName: string | null;
};

export async function getProductLots(productId: string): Promise<ProductLot[]> {
  await requireUser();
  const tdb = await db();

  const lots = await tdb
    .select({
      id: stockMovementsSchema.id,
      remainingQty: stockMovementsSchema.remainingQty,
      qty: stockMovementsSchema.qty,
      unitCost: stockMovementsSchema.unitCost,
      expiresAt: stockMovementsSchema.expiresAt,
      createdAt: stockMovementsSchema.createdAt,
      reason: stockMovementsSchema.reason,
      supplierId: stockMovementsSchema.supplierId,
    })
    .from(stockMovementsSchema)
    .where(
      and(
        eq(stockMovementsSchema.productId, productId),
        eq(stockMovementsSchema.type, 'entry'),
        gt(stockMovementsSchema.remainingQty, 0),
      ),
    )
    .orderBy(fifoBatchOrder);

  // Resolve supplier ids → names in one pass (supplier_id is free text today,
  // so only well-formed ids that match a supplier row get a name).
  const supplierIds = [
    ...new Set(lots.map(l => l.supplierId).filter((s): s is string => !!s)),
  ];
  const supplierNames = new Map<string, string>();
  if (supplierIds.length > 0) {
    const rows = await tdb
      .select({ id: suppliersSchema.id, name: suppliersSchema.name })
      .from(suppliersSchema)
      .where(inArray(suppliersSchema.id, supplierIds));
    for (const r of rows) {
      supplierNames.set(r.id, r.name);
    }
  }

  return lots.map(l => ({
    id: l.id,
    remainingQty: l.remainingQty ?? 0,
    qty: l.qty,
    unitCost: l.unitCost,
    expiresAt: l.expiresAt,
    createdAt: l.createdAt.toISOString(),
    reason: l.reason,
    supplierId: l.supplierId,
    supplierName: l.supplierId ? supplierNames.get(l.supplierId) ?? null : null,
  }));
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
      notes: stockMovementsSchema.notes,
      createdBy: stockMovementsSchema.createdBy,
      saleId: stockMovementsSchema.saleId,
      supplierId: stockMovementsSchema.supplierId,
      createdAt: stockMovementsSchema.createdAt,
    })
    .from(stockMovementsSchema)
    .leftJoin(productsSchema, eq(productsSchema.id, stockMovementsSchema.productId))
    .$dynamic();

  const q = filters.length > 0 ? base.where(and(...filters)) : base;

  const rows = await q
    .orderBy(desc(stockMovementsSchema.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // Resolve Clerk user ids → readable names for the "Quién" column. Cashier /
  // system ids won't match a Clerk user and fall back to their raw id.
  const names = await resolveActorNames(
    rows.map(r => r.createdBy).filter((id): id is string => !!id),
  );

  return rows.map(r => ({
    ...r,
    createdByName: r.createdBy ? names.get(r.createdBy) ?? r.createdBy : null,
  }));
}

async function resolveActorNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return out;
  }
  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({
      userId: unique,
      limit: unique.length,
    });
    for (const u of data) {
      const name
        = u.fullName
          || [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
          || u.primaryEmailAddress?.emailAddress
          || u.id;
      out.set(u.id, name);
    }
  } catch {
    // Clerk unreachable — callers fall back to the raw id.
  }
  return out;
}

// ── getInventoryView (table + KPIs + entitlement) ────────────────────────

export type InventoryStatus = 'ok' | 'low' | 'critical' | 'by_expiry';
export type ExpirationTier = 'atencion' | 'urgente' | 'critico';

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
  status: InventoryStatus;
  expiringTier: ExpirationTier | null;
  // True while Smart Stock manages the minimum (Pro + flag on) → MIN is
  // read-only in the table.
  aiManaged: boolean;
  aiWeeklySales: number | null;
};

export type InventoryView = {
  products: InventoryProduct[];
  inventoryValue: string;
  expiringCount: number;
  smartStock: SmartStockSettings;
};

const TIER_RANK: Record<ExpirationTier, number> = {
  atencion: 1,
  urgente: 2,
  critico: 3,
};

export async function getInventoryView(): Promise<InventoryView> {
  await requireUser();
  const tdb = await db();

  const [rows, expRows, valueRow, smartStock] = await Promise.all([
    tdb
      .select()
      .from(productsSchema)
      .where(eq(productsSchema.deleted, false))
      .orderBy(productsSchema.name),
    tdb
      .select({
        productId: expirationRiskCacheSchema.productId,
        payload: expirationRiskCacheSchema.payload,
      })
      .from(expirationRiskCacheSchema),
    tdb
      .select({
        total: sql<string>`COALESCE(SUM(${stockMovementsSchema.remainingQty} * COALESCE(${stockMovementsSchema.unitCost}, 0)), 0)::text`,
      })
      .from(stockMovementsSchema)
      .where(
        and(
          eq(stockMovementsSchema.type, 'entry'),
          gt(stockMovementsSchema.remainingQty, 0),
        ),
      ),
    getSmartStockSettings(),
  ]);

  // Highest expiration tier per product, read straight from the engine's cache.
  const tierByProduct = new Map<string, ExpirationTier>();
  for (const r of expRows) {
    const tier = (r.payload as { tier?: ExpirationTier } | null)?.tier;
    if (tier && (tier === 'atencion' || tier === 'urgente' || tier === 'critico')) {
      const prev = tierByProduct.get(r.productId);
      if (!prev || TIER_RANK[tier] > TIER_RANK[prev]) {
        tierByProduct.set(r.productId, tier);
      }
    }
  }

  // Per-product sales velocity, only when Smart Stock is on (powers the tooltip
  // and confirms the minimum the engine set).
  const weeklyByProduct = new Map<string, number>();
  if (smartStock.enabled) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    const velRows = await tdb
      .select({
        productId: saleItemsSchema.productId,
        totalQty: sql<string>`COALESCE(SUM(${saleItemsSchema.qty}), 0)`,
      })
      .from(salesSchema)
      .innerJoin(saleItemsSchema, eq(saleItemsSchema.saleId, salesSchema.id))
      .where(gte(salesSchema.createdAt, since))
      .groupBy(saleItemsSchema.productId);
    for (const v of velRows) {
      const weekly = (Number(v.totalQty) / 30) * 7;
      weeklyByProduct.set(v.productId, Math.round(weekly * 10) / 10);
    }
  }

  let expiringCount = 0;
  const products: InventoryProduct[] = rows.map((r) => {
    const expiringTier = tierByProduct.get(r.id) ?? null;
    if (expiringTier) {
      expiringCount += 1;
    }

    // Precedence: agotado → por vencer → bajo → ok. A product with no stock
    // can't expire, so 'critical' wins; otherwise at-risk lots outrank a low
    // reorder point because spoilage is money already lost.
    let status: InventoryStatus = 'ok';
    if (r.minStock > 0 && r.stock <= 0) {
      status = 'critical';
    } else if (expiringTier) {
      status = 'by_expiry';
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
      expiringTier,
      aiManaged: smartStock.enabled,
      aiWeeklySales: smartStock.enabled
        ? weeklyByProduct.get(r.id) ?? 0
        : null,
    };
  });

  return {
    products,
    inventoryValue: valueRow[0]?.total ?? '0',
    expiringCount,
    smartStock,
  };
}
