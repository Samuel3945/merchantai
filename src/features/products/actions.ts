'use server';

import type { ProductCreateInput, ProductUpdateInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  productsSchema,
  stockMovementsSchema,
} from '@/models/Schema';
import {

  productCreateSchema,
  productUpdateSchema,
} from './validation';

async function requireOrgId() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return orgId;
}

async function requireOrgAndUser() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

export type Product = typeof productsSchema.$inferSelect;

// Product augmented with usage flags. These drive the action menu (delete only
// for a virgin product) and the edit guards (lock unit of measure / perishable
// once the product has history). Computed server-side so the UI can never be
// tricked into an unsafe edit.
export type ProductRow = Product & {
  hasSales: boolean;
  hasMovements: boolean;
  hasDatedBatches: boolean;
};

// EXISTS probes reused by listProducts (per row) and the single-product guards.
// No organizationId filter needed: they correlate on products.id, a globally
// unique UUID PK that the outer query already scopes to the org, and a child row
// (sale_item/movement) can only reference a product owned by that same org — so
// cross-tenant leakage is impossible by construction.
//
// LITERAL table refs (alias si/sm + outer products.id), NOT drizzle column
// interpolation: ${table.column} renders UNqualified inside sql``, so a bare
// "id" in this correlated subquery would bind to the inner table's own id
// (sale_items/stock_movements both have an id PK) and the EXISTS would always be
// false — wrongly marking every product as virgin/deletable. Every site that
// uses these probes selects `.from(productsSchema)` unaliased, so `products.id`
// resolves to the outer row.
const hasSalesSql = sql<boolean>`EXISTS (
  SELECT 1 FROM sale_items si WHERE si.product_id = products.id
)`;
const hasMovementsSql = sql<boolean>`EXISTS (
  SELECT 1 FROM stock_movements sm WHERE sm.product_id = products.id
)`;
const hasDatedBatchesSql = sql<boolean>`EXISTS (
  SELECT 1 FROM stock_movements sm
  WHERE sm.product_id = products.id
    AND sm.expires_at IS NOT NULL
    AND COALESCE(sm.remaining_qty, 0) > 0
)`;

export async function listProducts(params?: {
  search?: string;
  includeArchived?: boolean;
}): Promise<ProductRow[]> {
  const orgId = await requireOrgId();
  const search = params?.search?.trim();

  const filters = [
    eq(productsSchema.organizationId, orgId),
    eq(productsSchema.deleted, false),
  ];

  // Archived products are hidden by default so the listing doesn't fill up with
  // discontinued items; the table's "Ver archivados" toggle opts back in.
  if (!params?.includeArchived) {
    filters.push(ne(productsSchema.status, 'archived'));
  }

  if (search) {
    const like = `%${search}%`;
    const searchFilter = or(
      ilike(productsSchema.name, like),
      ilike(productsSchema.barcode, like),
      ilike(productsSchema.category, like),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  return db
    .select({
      ...getTableColumns(productsSchema),
      hasSales: hasSalesSql,
      hasMovements: hasMovementsSql,
      hasDatedBatches: hasDatedBatchesSql,
    })
    .from(productsSchema)
    .where(and(...filters))
    .orderBy(desc(productsSchema.createdAt));
}

export async function getProductById(id: string): Promise<Product | null> {
  const orgId = await requireOrgId();
  const [row] = await db
    .select()
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getProductByBarcode(
  barcode: string,
): Promise<Product | null> {
  const orgId = await requireOrgId();
  const [row] = await db
    .select()
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.barcode, barcode),
        eq(productsSchema.deleted, false),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createProduct(input: ProductCreateInput) {
  const { userId, orgId } = await requireOrgAndUser();
  const data = productCreateSchema.parse(input);

  if (data.barcode) {
    const existing = await getProductByBarcode(data.barcode);
    if (existing) {
      throw new Error(`Barcode "${data.barcode}" already exists`);
    }
  }

  const initialQty = data.initialQty ?? 0;

  // The form captures the unit cost as the opening-batch cost (initialCost);
  // there is no separate base-cost input, so products.cost — the cost basis
  // used by margin and inventory valuation — must be seeded from the opening
  // batch. Without this it stays '0' and margins read as 100%.
  const baseCost
    = data.cost && Number(data.cost) > 0 ? data.cost : (data.initialCost ?? data.cost);

  // Product insert + opening FIFO batch are atomic: if the movement insert
  // fails we don't want a product with phantom stock. The batch is a
  // stock_movements 'entry' row (remainingQty = qty) — the same lot model
  // recordMovement() uses — but inlined here so it shares this transaction.
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(productsSchema)
      .values({
        organizationId: orgId,
        name: data.name,
        barcode: data.barcode ?? null,
        price: data.price,
        cost: baseCost,
        // Stock comes from the opening batch when present, so it has a single
        // source of truth; otherwise it falls back to the provided value.
        stock: initialQty > 0 ? 0 : data.stock,
        category: data.category ?? null,
        unitType: data.unitType,
        isPerishable: data.isPerishable,
        isWholesale: data.isWholesale,
        wholesaleTiers: data.wholesaleTiers ?? null,
        attributes: data.attributes,
        status: data.status,
        publishAt: data.publishAt ?? null,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to create product');
    }

    if (initialQty <= 0) {
      return created;
    }

    await tx.insert(stockMovementsSchema).values({
      organizationId: orgId,
      productId: created.id,
      productName: created.name,
      type: 'entry',
      qty: initialQty,
      remainingQty: initialQty,
      unitCost: data.initialCost ?? null,
      // Expiry only matters for perishables; the engine reads it off the batch.
      expiresAt: data.isPerishable ? (data.initialExpiresAt ?? null) : null,
      reason: 'purchase',
      createdBy: userId,
    });

    const [updated] = await tx
      .update(productsSchema)
      .set({ stock: sql`${productsSchema.stock} + ${initialQty}` })
      .where(eq(productsSchema.id, created.id))
      .returning();

    return updated ?? created;
  });

  revalidatePath('/dashboard/products');
  revalidatePath('/dashboard/inventory');
  return row;
}

export async function updateProduct(id: string, input: ProductUpdateInput) {
  const { userId, orgId } = await requireOrgAndUser();
  const data = productUpdateSchema.parse(input);

  if (data.barcode) {
    const [conflict] = await db
      .select({ id: productsSchema.id })
      .from(productsSchema)
      .where(
        and(
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.barcode, data.barcode),
          eq(productsSchema.deleted, false),
        ),
      )
      .limit(1);
    if (conflict && conflict.id !== id) {
      throw new Error(`Barcode "${data.barcode}" already exists`);
    }
  }

  // Lock the product row, evaluate the guards and apply the update in one
  // transaction so a concurrent sale/movement can't flip hasSales/hasMovements
  // between the guard read and the write (which would let unitType change on a
  // product that just gained history). Sale paths lock the product FOR UPDATE,
  // so this serializes against them.
  const { row, previous } = await db.transaction(async (tx) => {
    const [prev] = await tx
      .select({
        price: productsSchema.price,
        stock: productsSchema.stock,
        name: productsSchema.name,
        unitType: productsSchema.unitType,
        isPerishable: productsSchema.isPerishable,
        hasSales: hasSalesSql,
        hasMovements: hasMovementsSql,
        hasDatedBatches: hasDatedBatchesSql,
      })
      .from(productsSchema)
      .where(
        and(
          eq(productsSchema.id, id),
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.deleted, false),
        ),
      )
      .for('update')
      .limit(1);

    if (!prev) {
      throw new Error('Product not found');
    }

    const inUse = prev.hasSales || prev.hasMovements;

    // Guard: unit of measure is the meaning of every stored quantity. Changing
    // it after any sale or stock movement corrupts the FIFO ledger and
    // inventory math, so it's locked once the product has history.
    if (
      data.unitType !== undefined
      && data.unitType !== prev.unitType
      && inUse
    ) {
      throw new Error(
        'No se puede cambiar la unidad de medida: el producto ya tiene inventario o ventas. Cambiarla dañaría el cálculo de stock.',
      );
    }

    // Guard: a product can become perishable at any time, but it can't stop
    // being perishable while it still has dated batches with stock — those lots
    // would lose their expiry tracking.
    if (
      data.isPerishable === false
      && prev.isPerishable
      && prev.hasDatedBatches
    ) {
      throw new Error(
        'No se puede desactivar «Se vence» mientras existan lotes con fecha de caducidad y stock. Agota o ajusta esos lotes primero.',
      );
    }

    const [updatedRow] = await tx
      .update(productsSchema)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.barcode !== undefined && { barcode: data.barcode }),
        ...(data.price !== undefined && { price: data.price }),
        ...(data.cost !== undefined && { cost: data.cost }),
        // Stock is intentionally NOT settable here — it's owned by inventory
        // movements (recordMovement). A product edit must never change stock.
        ...(data.category !== undefined && { category: data.category }),
        ...(data.unitType !== undefined && { unitType: data.unitType }),
        ...(data.isPerishable !== undefined && {
          isPerishable: data.isPerishable,
        }),
        ...(data.isWholesale !== undefined && { isWholesale: data.isWholesale }),
        ...(data.wholesaleTiers !== undefined && {
          wholesaleTiers: data.wholesaleTiers,
        }),
        ...(data.attributes !== undefined && { attributes: data.attributes }),
        // Status is owned by the state-machine transitions (setProductStatus),
        // never by a general field edit — the edit form no longer sends it.
      })
      .where(
        and(
          eq(productsSchema.id, id),
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.deleted, false),
        ),
      )
      .returning();

    if (!updatedRow) {
      throw new Error('Product not found');
    }

    return { row: updatedRow, previous: prev };
  });

  // Only audit when price or stock actually changed — the brief calls out
  // those two as the "manual" cases worth recording; touch-ups to name,
  // category, etc. would flood the log without much signal.
  const priceChanged
    = previous !== undefined && row.price !== previous.price;
  const stockChanged
    = previous !== undefined && row.stock !== previous.stock;

  if (priceChanged || stockChanged) {
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'product.updated',
      entityType: 'product',
      entityId: row.id,
      // Only the real stored fields — not the synthetic hasSales/hasMovements
      // guard flags carried on `previous` — belong in the audit trail.
      before: {
        name: previous.name,
        price: previous.price,
        stock: previous.stock,
      },
      after: { name: row.name, price: row.price, stock: row.stock },
      metadata: {
        priceChanged,
        stockChanged,
        fields: [
          ...(priceChanged ? ['price'] : []),
          ...(stockChanged ? ['stock'] : []),
        ],
      },
    });
  }

  revalidatePath('/dashboard/products');
  return row;
}

export type ProductStatusTransition = 'published' | 'archived';

// State machine: draft/archived -> published, published -> archived. A product
// never returns to draft once it leaves it, and archiving keeps the full
// history intact (nothing is deleted).
export async function setProductStatus(
  id: string,
  next: ProductStatusTransition,
): Promise<Product> {
  const orgId = await requireOrgId();

  const [current] = await db
    .select({ status: productsSchema.status })
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
      ),
    )
    .limit(1);

  if (!current) {
    throw new Error('Product not found');
  }

  const allowed
    = (next === 'published' && current.status !== 'published')
      || (next === 'archived' && current.status === 'published');

  if (!allowed) {
    throw new Error('Transición de estado no permitida');
  }

  // Compare-and-swap: the UPDATE only matches if the status is still what we
  // read, so two concurrent transitions can't both apply (TOCTOU-safe without a
  // transaction). A zero-row result means another change won the race.
  const [row] = await db
    .update(productsSchema)
    .set({ status: next, publishAt: null })
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
        eq(productsSchema.status, current.status),
      ),
    )
    .returning();

  if (!row) {
    throw new Error('El estado del producto cambió, vuelve a intentarlo.');
  }

  revalidatePath('/dashboard/products');
  return row;
}

// Hard delete is only allowed for a virgin product — one with no sales and no
// stock movements, so there is no history to damage. Anything with history must
// be archived instead. The FK restrict on sale_items/stock_movements is the
// last-resort backstop; this check produces a clear message first.
export async function deleteProduct(id: string) {
  const orgId = await requireOrgId();

  // Lock the product row and re-check "virgin" inside one transaction so a
  // concurrent sale can't slip history in between the check and the delete.
  // Both sale_items and stock_movements now carry an ON DELETE restrict FK, so
  // the DB is the final backstop even against paths that don't lock the product;
  // this app-level check just produces a friendlier message first.
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: productsSchema.id,
        hasSales: hasSalesSql,
        hasMovements: hasMovementsSql,
      })
      .from(productsSchema)
      .where(
        and(
          eq(productsSchema.id, id),
          eq(productsSchema.organizationId, orgId),
          eq(productsSchema.deleted, false),
        ),
      )
      .for('update')
      .limit(1);

    if (!target) {
      throw new Error('Product not found');
    }

    if (target.hasSales || target.hasMovements) {
      throw new Error(
        'No se puede eliminar un producto con ventas o movimientos de inventario. Archívalo para quitarlo de la venta sin perder el historial.',
      );
    }

    await tx
      .delete(productsSchema)
      .where(
        and(eq(productsSchema.id, id), eq(productsSchema.organizationId, orgId)),
      );
  });

  revalidatePath('/dashboard/products');
  return { id };
}

// Bulk operations cap — a single call never touches more than this many rows, so
// a runaway selection (or a tampered client payload) can't issue an unbounded
// UPDATE. Well above any realistic on-screen selection.
const MAX_BULK = 500;

// Bulk publish/archive. Applies the SAME state-machine rules as
// setProductStatus, but set-wise: the source-status filter is part of the WHERE,
// so products already in the target state (or not in a valid source state) are
// simply skipped instead of erroring. Returns how many rows actually changed.
export async function bulkSetProductStatus(
  ids: string[],
  next: ProductStatusTransition,
): Promise<{ updated: number }> {
  const { userId, orgId } = await requireOrgAndUser();
  const unique = [...new Set(ids)].slice(0, MAX_BULK);
  if (unique.length === 0) {
    return { updated: 0 };
  }

  // publish: anything not already published -> published.
  // archive: only published -> archived (mirrors setProductStatus).
  const sourceFilter
    = next === 'published'
      ? ne(productsSchema.status, 'published')
      : eq(productsSchema.status, 'published');

  const rows = await db
    .update(productsSchema)
    .set({ status: next, publishAt: null })
    .where(
      and(
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
        inArray(productsSchema.id, unique),
        sourceFilter,
      ),
    )
    .returning({ id: productsSchema.id });

  if (rows.length > 0) {
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'product.bulk_status_changed',
      entityType: 'product',
      metadata: { status: next, count: rows.length, ids: rows.map(r => r.id) },
    });
  }

  revalidatePath('/dashboard/products');
  return { updated: rows.length };
}

export type BulkPriceMode = 'percent' | 'amount';

// Bulk price increase — by a percentage (+15%) or a flat amount (+$500) on each
// product's current price. The arithmetic runs in SQL so it's atomic and never
// round-trips every row: ROUND(..., 2) keeps the result inside the numeric(10,2)
// column precision. Increase-only by design (value must be > 0); a fat-finger
// guard caps the percentage. The DB's numeric overflow is the final backstop.
export async function bulkAdjustPrice(
  ids: string[],
  mode: BulkPriceMode,
  value: number,
): Promise<{ updated: number }> {
  const { userId, orgId } = await requireOrgAndUser();

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('El valor debe ser mayor a 0.');
  }
  if (mode === 'percent' && value > 1000) {
    throw new Error('El porcentaje es demasiado alto (máximo 1000%).');
  }

  const unique = [...new Set(ids)].slice(0, MAX_BULK);
  if (unique.length === 0) {
    return { updated: 0 };
  }

  const nextPrice
    = mode === 'percent'
      ? sql`ROUND(${productsSchema.price} * (1 + ${value}::numeric / 100), 2)`
      : sql`ROUND(${productsSchema.price} + ${value}::numeric, 2)`;

  const rows = await db
    .update(productsSchema)
    .set({ price: nextPrice })
    .where(
      and(
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
        inArray(productsSchema.id, unique),
      ),
    )
    .returning({ id: productsSchema.id });

  if (rows.length > 0) {
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'product.bulk_price_updated',
      entityType: 'product',
      metadata: { mode, value, count: rows.length, ids: rows.map(r => r.id) },
    });
  }

  revalidatePath('/dashboard/products');
  return { updated: rows.length };
}
