'use server';

import type { ProductCreateInput, ProductUpdateInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  productsSchema,
  saleItemsSchema,
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
const hasSalesSql = sql<boolean>`EXISTS (
  SELECT 1 FROM ${saleItemsSchema}
  WHERE ${saleItemsSchema.productId} = ${productsSchema.id}
)`;
const hasMovementsSql = sql<boolean>`EXISTS (
  SELECT 1 FROM ${stockMovementsSchema}
  WHERE ${stockMovementsSchema.productId} = ${productsSchema.id}
)`;
const hasDatedBatchesSql = sql<boolean>`EXISTS (
  SELECT 1 FROM ${stockMovementsSchema}
  WHERE ${stockMovementsSchema.productId} = ${productsSchema.id}
    AND ${stockMovementsSchema.expiresAt} IS NOT NULL
    AND COALESCE(${stockMovementsSchema.remainingQty}, 0) > 0
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
        warrantyType: data.warrantyType ?? null,
        warrantyDurationDays: data.warrantyDurationDays ?? null,
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

  const [previous] = await db
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
    .limit(1);

  if (!previous) {
    throw new Error('Product not found');
  }

  const inUse = previous.hasSales || previous.hasMovements;

  // Guard: unit of measure is the meaning of every stored quantity. Changing it
  // after any sale or stock movement corrupts the FIFO ledger and inventory
  // math, so it's locked once the product has history.
  if (
    data.unitType !== undefined
    && data.unitType !== previous.unitType
    && inUse
  ) {
    throw new Error(
      'No se puede cambiar la unidad de medida: el producto ya tiene inventario o ventas. Cambiarla dañaría el cálculo de stock.',
    );
  }

  // Guard: a product can become perishable at any time, but it can't stop being
  // perishable while it still has dated batches with stock — those lots would
  // lose their expiry tracking.
  if (
    data.isPerishable === false
    && previous.isPerishable
    && previous.hasDatedBatches
  ) {
    throw new Error(
      'No se puede desactivar «Se vence» mientras existan lotes con fecha de caducidad y stock. Agota o ajusta esos lotes primero.',
    );
  }

  const [row] = await db
    .update(productsSchema)
    .set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.barcode !== undefined && { barcode: data.barcode }),
      ...(data.price !== undefined && { price: data.price }),
      ...(data.cost !== undefined && { cost: data.cost }),
      ...(data.stock !== undefined && { stock: data.stock }),
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
      ...(data.warrantyType !== undefined && {
        warrantyType: data.warrantyType,
      }),
      ...(data.warrantyDurationDays !== undefined && {
        warrantyDurationDays: data.warrantyDurationDays,
      }),
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

  if (!row) {
    throw new Error('Product not found');
  }

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
      before: previous,
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

  const [row] = await db
    .update(productsSchema)
    .set({ status: next, publishAt: null })
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
      ),
    )
    .returning();

  if (!row) {
    throw new Error('Product not found');
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

  const [target] = await db
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
    .limit(1);

  if (!target) {
    throw new Error('Product not found');
  }

  if (target.hasSales || target.hasMovements) {
    throw new Error(
      'No se puede eliminar un producto con ventas o movimientos de inventario. Archívalo para quitarlo de la venta sin perder el historial.',
    );
  }

  await db
    .delete(productsSchema)
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
      ),
    );

  revalidatePath('/dashboard/products');
  return { id };
}

export async function decrementStock(id: string, qty: number) {
  const orgId = await requireOrgId();

  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('qty must be a positive number');
  }

  const [row] = await db
    .update(productsSchema)
    .set({
      stock: sql`GREATEST(0, ${productsSchema.stock} - ${qty})`,
    })
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
      ),
    )
    .returning();

  if (!row) {
    throw new Error('Product not found');
  }

  revalidatePath('/dashboard/products');
  return row;
}
