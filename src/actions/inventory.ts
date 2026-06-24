'use server';

import type { SQL } from 'drizzle-orm';
import type { SmartStockSettings } from '@/actions/smart-stock';
import type { InvoiceContext } from '@/libs/supplier-invoice-payment';
import type { TreasuryAccountRow } from '@/libs/treasury';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { and, desc, eq, gt, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getSmartStockSettings } from '@/actions/smart-stock';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/db-context';
import { fifoBatchOrder } from '@/libs/fifo-cogs';
import { requirePanelModule } from '@/libs/panel-session';
import { resolveInvoiceInTx } from '@/libs/supplier-invoice-payment';
import { insertPurchasePayable } from '@/libs/supplier-payables';
import { applyReturnCredit } from '@/libs/supplier-returns';
import {
  listTreasuryAccounts as listTreasuryAccountsLib,
  recordSupplierPaymentOutflow,
} from '@/libs/treasury';
import {
  expirationRiskCacheSchema,
  productsSchema,
  saleItemsSchema,
  salesSchema,
  stockMovementsSchema,
  supplierPayablesSchema,
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
  // ── Pay-at-entry (S2-T4, REQ-3.x) — optional, additive, no breaking change ──
  // Only read when reason === 'purchase'. Existing callers without these fields
  // default to 'unpaid' and no outflow is written.
  paymentStatus?: 'unpaid' | 'full' | 'partial' | null;
  paymentAmount?: string | null;
  paymentAccountId?: string | null;
  // ── Invoice grouping (migration 0069) — optional, additive ───────────────
  // When set, creates/reuses a supplier_purchases header in the SAME tx and
  // stamps purchase_id on the created payable. Default (undefined) = standalone,
  // purchase_id null — fully back-compat for existing callers.
  invoiceContext?: InvoiceContext | null;
};

export type StockMovement = typeof stockMovementsSchema.$inferSelect;

// ── recordMovement ───────────────────────────────────────────────────────

export async function recordMovement(input: RecordMovementInput) {
  await requirePanelModule('inventory');
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
      isPerishable: productsSchema.isPerishable,
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

  // Every entry field is mandatory — enforced server-side so the form can't be
  // bypassed. Cost is required for FIFO valuation; a purchase must name its
  // supplier; a perishable lot must carry its expiry for the spoilage engine.
  if (input.type === 'entry') {
    if (input.unitCost == null || !(Number(input.unitCost) > 0)) {
      throw new Error('El costo unitario es obligatorio y debe ser mayor a 0');
    }
    if (input.reason === 'purchase' && !input.supplierId) {
      throw new Error('El proveedor es obligatorio para una compra');
    }
    if (product.isPerishable && !input.expiresAt) {
      throw new Error('La fecha de caducidad es obligatoria para productos perecederos');
    }
  }

  // Defense in depth: server-side payment field validation for purchase entries.
  // The Zod refinement in entryFormSchema runs only on the client; enforce the
  // same rules here so the money path cannot be reached with invalid fields
  // regardless of the caller. Callers that omit payment fields default to
  // 'unpaid' and bypass this guard (no breaking change for existing callers).
  if (input.reason === 'purchase') {
    const pStatus = input.paymentStatus ?? 'unpaid';
    if (pStatus === 'full' || pStatus === 'partial') {
      if (!input.paymentAccountId) {
        throw new Error(
          'Seleccioná el contenedor de donde sale el dinero',
        );
      }
    }
    if (pStatus === 'partial') {
      const amt = Number(input.paymentAmount);
      const total = input.qty * Number(input.unitCost ?? '0');
      if (!input.paymentAmount || !Number.isFinite(amt) || amt <= 0) {
        throw new Error('El monto parcial debe ser mayor a 0');
      }
      if (amt >= total) {
        throw new Error(
          'El monto parcial debe ser menor al total de la compra (usá "Sí, pagué el total" para pago completo)',
        );
      }
    }
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

    // For return_supplier exits with a supplierId, apply return credits FIFO across
    // the supplier's open/partial payables in the SAME tx as the exit movement.
    // Value = returned qty × FIFO weighted cost captured in unitCost (already computed).
    // No treasury movement is written — this is a liability credit only.
    // Back-compat: no supplierId → pure inventory exit, no payable change.
    let returnCreditResult: { appliedTotal: number; unapplied: number } | null = null;
    if (input.reason === 'return_supplier' && input.supplierId && movement && Number(unitCost) > 0) {
      const returnValue = input.qty * Number(unitCost);
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle tx is structurally compatible with Executor
      returnCreditResult = await applyReturnCredit(tx as any, {
        organizationId: orgId,
        supplierId: input.supplierId,
        returnStockMovementId: movement.id as string,
        amount: returnValue,
        createdBy: userId,
        note: notes ?? null,
      });
    }

    // For purchase entries, create one open supplier_payables row in the same tx.
    // totalAmount = qty × unitCost, frozen at this moment (REQ-2.2, REQ-7.2).
    // Non-purchase entries create NO payable (REQ-2.6).
    if (input.reason === 'purchase' && movement && input.supplierId && unitCost) {
      if (!movement?.id) {
        throw new Error('stock movement insert returned no id');
      }
      const movementId = movement.id as string;

      // Resolve invoice header if invoiceContext is provided (migration 0069).
      // Default (no context) = standalone purchase, purchase_id = null.
      let purchaseId: string | null = null;
      if (input.invoiceContext) {
        // biome-ignore lint/suspicious/noExplicitAny: TenantDb tx is structurally compatible with Executor
        const resolved = await resolveInvoiceInTx(tx as any, {
          organizationId: orgId,
          supplierId: input.supplierId,
          createdBy: userId,
          context: input.invoiceContext,
        });
        purchaseId = resolved.purchaseId;
      }

      const newPayable = await insertPurchasePayable(tx, {
        organizationId: orgId,
        supplierId: input.supplierId,
        stockMovementId: movementId,
        qty: input.qty,
        unitCost,
        createdBy: userId,
        notes: null,
        purchaseId,
      });

      // Pay-at-entry (REQ-3.x, S2-T4): if the user already paid or partially
      // paid at entry time, debit the chosen container in the SAME tx.
      // Balance/cap errors roll back lot + payable + payment all-or-nothing.
      // 'unpaid'/missing → payable stays open, no outflow written (REQ-3.2).
      const pStatus = input.paymentStatus ?? 'unpaid';
      if (
        (pStatus === 'full' || pStatus === 'partial')
        && input.paymentAccountId
      ) {
        const totalAmount = input.qty * Number(unitCost);
        const payAmt
          = pStatus === 'full'
            ? totalAmount
            : Number(input.paymentAmount ?? '0');

        // biome-ignore lint/suspicious/noExplicitAny: TenantDb tx is structurally compatible with Executor at runtime
        await recordSupplierPaymentOutflow(tx as any, {
          organizationId: orgId,
          fromAccountId: input.paymentAccountId,
          amount: payAmt,
          supplierId: input.supplierId,
          payableId: newPayable.id,
          note: null,
          createdBy: userId,
        });
      }
    }

    return { movement, product: updated, stockBefore: product.stock, returnCreditResult };
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
  revalidatePath('/dashboard/suppliers');
  return result;
}

// ── updateMinStock ───────────────────────────────────────────────────────
// Manual edit of the reorder point. Refused while Smart Stock manages the
// minimum (Pro + flag on) — the column is read-only in that state.

export async function updateMinStock(productId: string, minStock: number) {
  await requirePanelModule('inventory');
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
  // Linked payable info — null when no payable exists for this lot (e.g. initial stock load).
  payableId: string | null;
  outstanding: string | null;
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
      // Payable info via unique index on stock_movement_id (O(1) lookup).
      payableId: supplierPayablesSchema.id,
      // outstanding = totalAmount − paidAmount − creditedAmount, floored at 0.
      outstanding: sql<string>`GREATEST(
        0,
        CAST(${supplierPayablesSchema.totalAmount} AS numeric)
          - CAST(${supplierPayablesSchema.paidAmount} AS numeric)
          - CAST(COALESCE(${supplierPayablesSchema.creditedAmount}, '0') AS numeric)
      )::text`,
    })
    .from(stockMovementsSchema)
    .leftJoin(
      supplierPayablesSchema,
      eq(supplierPayablesSchema.stockMovementId, stockMovementsSchema.id),
    )
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
    payableId: l.payableId ?? null,
    outstanding: l.payableId != null ? (l.outstanding ?? null) : null,
  }));
}

// ── listMovements ────────────────────────────────────────────────────────

export type ListMovementsParams = {
  productId?: string;
  supplierId?: string;
  type?: MovementType;
  reason?: MovementReason;
  createdBy?: string;
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
  if (params?.supplierId) {
    filters.push(eq(stockMovementsSchema.supplierId, params.supplierId));
  }
  if (params?.type) {
    filters.push(eq(stockMovementsSchema.type, params.type));
  }
  if (params?.reason) {
    filters.push(eq(stockMovementsSchema.reason, params.reason));
  }
  if (params?.createdBy) {
    filters.push(eq(stockMovementsSchema.createdBy, params.createdBy));
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

export type MovementActor = { id: string; name: string };

// Distinct people who recorded a movement, for the history "Usuario" filter.
// Resolved to readable names; sorted for a stable dropdown.
export async function listMovementActors(): Promise<MovementActor[]> {
  await requireUser();
  const tdb = await db();
  const rows = await tdb
    .select({ createdBy: stockMovementsSchema.createdBy })
    .from(stockMovementsSchema)
    .where(isNotNull(stockMovementsSchema.createdBy))
    .groupBy(stockMovementsSchema.createdBy);

  const ids = rows
    .map(r => r.createdBy)
    .filter((id): id is string => !!id);
  const names = await resolveActorNames(ids);

  return ids
    .map(id => ({ id, name: names.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
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

  const [rows, expRows, valueRow, ledgerRows, smartStock] = await Promise.all([
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
    tdb
      .select({
        productId: stockMovementsSchema.productId,
        remaining: sql<string>`COALESCE(SUM(${stockMovementsSchema.remainingQty}), 0)::text`,
      })
      .from(stockMovementsSchema)
      .where(
        and(
          eq(stockMovementsSchema.type, 'entry'),
          gt(stockMovementsSchema.remainingQty, 0),
        ),
      )
      .groupBy(stockMovementsSchema.productId),
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

  // products.stock is a cache of the FIFO ledger (see CLAUDE.md). When a product
  // has open lots, the ledger is authoritative — self-heal any drift so the table
  // can never contradict the lots drawer. We only ever reconcile UP to a positive
  // ledger sum: a product may legitimately hold "carga inicial" stock with no
  // lots (ledger sum 0), and zeroing it would wipe real inventory.
  const ledgerByProduct = new Map<string, number>();
  for (const lr of ledgerRows) {
    ledgerByProduct.set(lr.productId, Number(lr.remaining));
  }
  const healedById = new Map<string, number>();
  for (const r of rows) {
    const ledger = ledgerByProduct.get(r.id);
    if (ledger != null && ledger > 0 && ledger !== r.stock) {
      healedById.set(r.id, ledger);
    }
  }
  if (healedById.size > 0) {
    await Promise.all(
      [...healedById].map(([id, stock]) =>
        tdb.update(productsSchema).set({ stock }).where(eq(productsSchema.id, id)),
      ),
    );
  }

  let expiringCount = 0;
  const products: InventoryProduct[] = rows.map((r) => {
    const stock = healedById.get(r.id) ?? r.stock;
    const expiringTier = tierByProduct.get(r.id) ?? null;
    if (expiringTier) {
      expiringCount += 1;
    }

    // Precedence: agotado → por vencer → bajo → ok. A product with no stock
    // can't expire, so 'critical' wins; otherwise at-risk lots outrank a low
    // reorder point because spoilage is money already lost.
    let status: InventoryStatus = 'ok';
    if (r.minStock > 0 && stock <= 0) {
      status = 'critical';
    } else if (expiringTier) {
      status = 'by_expiry';
    } else if (r.minStock > 0 && stock <= r.minStock) {
      status = 'low';
    }

    return {
      id: r.id,
      name: r.name,
      stock,
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

// ── Bulk stock entries (import) ──────────────────────────────────────────
// The inventory importer assigns units to products that ALREADY exist (unlike
// the products importer, which creates them). It needs a lightweight lookup to
// match file rows by barcode/name and to feed the per-row product picker.

export type EntryTarget = {
  id: string;
  name: string;
  barcode: string | null;
  cost: string;
  isPerishable: boolean;
};

export async function listEntryTargets(): Promise<EntryTarget[]> {
  await requirePanelModule('inventory');
  const tdb = await db();

  const rows = await tdb
    .select({
      id: productsSchema.id,
      name: productsSchema.name,
      barcode: productsSchema.barcode,
      cost: productsSchema.cost,
      isPerishable: productsSchema.isPerishable,
    })
    .from(productsSchema)
    .where(eq(productsSchema.deleted, false))
    .orderBy(productsSchema.name);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    barcode: r.barcode ?? null,
    cost: String(r.cost),
    isPerishable: r.isPerishable,
  }));
}

export type BulkEntryRow = {
  productId: string;
  qty: number;
  unitCost: string;
  expiresAt?: string | null;
};

export type BulkEntryInput = {
  reason: 'purchase' | 'manual';
  supplierId?: string | null;
  notes?: string | null;
  rows: BulkEntryRow[];
};

export type BulkEntryResult = {
  created: number;
  failed: { row: number; productId: string; error: string }[];
};

// Reuses recordMovement per row so the FIFO ledger, audit log and the
// products.stock = SUM(remaining_qty) invariant stay identical to a single
// manual entry. Rows are independent: one bad row never blocks the rest.
export async function bulkRecordEntries(
  input: BulkEntryInput,
): Promise<BulkEntryResult> {
  await requirePanelModule('inventory');

  let created = 0;
  const failed: BulkEntryResult['failed'] = [];

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    try {
      await recordMovement({
        productId: row.productId,
        type: 'entry',
        qty: row.qty,
        reason: input.reason,
        unitCost: row.unitCost,
        supplierId: input.reason === 'purchase' ? input.supplierId ?? null : null,
        expiresAt: row.expiresAt ?? null,
        notes: input.reason === 'manual' ? input.notes ?? null : null,
      });
      created += 1;
    } catch (err) {
      failed.push({
        row: i + 1,
        productId: row.productId,
        error: err instanceof Error ? err.message : 'Error inesperado',
      });
    }
  }

  return { created, failed };
}

// ── listPaymentContainers (S2-T4 companion) ───────────────────────────────────
// Returns active treasury containers (caja, caja_fuerte, banco) for the org.
// Called from EntryModal to populate the ContainerSelector for pay-at-entry.
// Excludes 'transito' (Pendiente de ubicar) — purchases must not land there.
// Requires 'inventory' module (same gate as the entry form).

export type PaymentContainer = {
  id: string;
  name: string;
  type: 'caja' | 'caja_fuerte' | 'banco';
};

export async function listPaymentContainers(): Promise<PaymentContainer[]> {
  const { orgId } = await requirePanelModule('inventory');
  const rawDb = db.unsafeNoOrgFilter(
    'listPaymentContainers: treasury_accounts queried directly with explicit org filter',
  );
  const accounts: TreasuryAccountRow[] = await listTreasuryAccountsLib(rawDb, orgId);
  return accounts
    .filter(a => a.type === 'caja' || a.type === 'caja_fuerte' || a.type === 'banco')
    .map(a => ({
      id: a.id,
      name: a.name,
      type: a.type as 'caja' | 'caja_fuerte' | 'banco',
    }));
}

// ── listRefundContainers ──────────────────────────────────────────────────────
// Returns ONLY caja_fuerte and banco containers for supplier refund destinations.
// Excludes live POS cajas (type='caja') to prevent arqueo leaks: injecting cash
// into a live caja bypasses the blind cash-session closing count.
// Design: POS-caja refunds are deferred; refunds must land in a non-session
// container (caja_fuerte or banco) only.

export type RefundContainer = {
  id: string;
  name: string;
  type: 'caja_fuerte' | 'banco';
};

export async function listRefundContainers(): Promise<RefundContainer[]> {
  const { orgId } = await requirePanelModule('inventory');
  const rawDb = db.unsafeNoOrgFilter(
    'listRefundContainers: treasury_accounts queried directly with explicit org filter',
  );
  const accounts: TreasuryAccountRow[] = await listTreasuryAccountsLib(rawDb, orgId);
  return accounts
    .filter(a => a.type === 'caja_fuerte' || a.type === 'banco')
    .map(a => ({
      id: a.id,
      name: a.name,
      type: a.type as 'caja_fuerte' | 'banco',
    }));
}
