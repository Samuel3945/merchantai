'use server';

import type { ProductCreateInput, ProductUpdateInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { productsSchema, stockMovementsSchema } from '@/models/Schema';
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

export async function listProducts(params?: { search?: string }) {
  const orgId = await requireOrgId();
  const search = params?.search?.trim();

  const filters = [
    eq(productsSchema.organizationId, orgId),
    eq(productsSchema.deleted, false),
  ];

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
    .select()
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
        cost: data.cost,
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

  const [previous] = await db
    .select({
      price: productsSchema.price,
      stock: productsSchema.stock,
      name: productsSchema.name,
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
      ...(data.status !== undefined && { status: data.status }),
      ...(data.publishAt !== undefined && { publishAt: data.publishAt }),
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

export async function softDeleteProduct(id: string) {
  const orgId = await requireOrgId();

  const [row] = await db
    .update(productsSchema)
    .set({ deleted: true })
    .where(
      and(
        eq(productsSchema.id, id),
        eq(productsSchema.organizationId, orgId),
        eq(productsSchema.deleted, false),
      ),
    )
    .returning({ id: productsSchema.id });

  if (!row) {
    throw new Error('Product not found');
  }

  revalidatePath('/dashboard/products');
  return { id: row.id };
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
