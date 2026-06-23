'use server';

import type { SupplierCreateInput, SupplierUpdateInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import { and, asc, eq, gte, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { isUniqueViolation } from '@/libs/action-result';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  cashMovementsSchema,
  productsSchema,
  supplierProductsSchema,
  suppliersSchema,
} from '@/models/Schema';
import { supplierCreateSchema, supplierUpdateSchema } from './validation';

async function requireOrgId() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

export type Supplier = typeof suppliersSchema.$inferSelect;

// Lightweight reference to a product a supplier provides.
export type SupplierProductRef = { id: string; name: string };

// A supplier plus the products it provides — what create/update return so the
// caller can refresh the row in place without a second fetch.
export type SupplierWithProducts = Supplier & {
  products: SupplierProductRef[];
};

// A supplier row enriched with payment data derived live from the cash ledger —
// single source of truth, no stored aggregates that could drift.
export type SupplierListItem = Supplier & {
  lastPaymentAt: Date | null;
  totalPaid: string;
  products: SupplierProductRef[];
};

// Drizzle transaction handle — same query surface as `db`, scoped to the tx.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Products (id + name) a set of suppliers provides, grouped by supplier id.
// Archived/deleted products are excluded so stale links don't surface.
async function loadProductRefsBySupplier(
  orgId: string,
  supplierIds: string[],
): Promise<Map<string, SupplierProductRef[]>> {
  const map = new Map<string, SupplierProductRef[]>();
  if (supplierIds.length === 0) {
    return map;
  }

  const rows = await db
    .select({
      supplierId: supplierProductsSchema.supplierId,
      id: productsSchema.id,
      name: productsSchema.name,
    })
    .from(supplierProductsSchema)
    .innerJoin(
      productsSchema,
      eq(productsSchema.id, supplierProductsSchema.productId),
    )
    .where(
      and(
        eq(supplierProductsSchema.organizationId, orgId),
        inArray(supplierProductsSchema.supplierId, supplierIds),
        eq(productsSchema.deleted, false),
      ),
    )
    .orderBy(asc(productsSchema.name));

  for (const r of rows) {
    const list = map.get(r.supplierId);
    if (list) {
      list.push({ id: r.id, name: r.name });
    } else {
      map.set(r.supplierId, [{ id: r.id, name: r.name }]);
    }
  }
  return map;
}

async function loadSupplierProducts(
  orgId: string,
  supplierId: string,
): Promise<SupplierProductRef[]> {
  const map = await loadProductRefsBySupplier(orgId, [supplierId]);
  return map.get(supplierId) ?? [];
}

// Replace a supplier's product links with the given set. Delete-then-insert is
// simple and correct for the handful of products a supplier carries. Product
// ids are filtered to the org as defense in depth against cross-org assignment.
async function syncSupplierProducts(
  tx: Tx,
  orgId: string,
  supplierId: string,
  productIds: string[],
): Promise<void> {
  await tx
    .delete(supplierProductsSchema)
    .where(eq(supplierProductsSchema.supplierId, supplierId));

  const unique = [...new Set(productIds)];
  if (unique.length === 0) {
    return;
  }

  const owned = await tx
    .select({ id: productsSchema.id })
    .from(productsSchema)
    .where(
      and(
        eq(productsSchema.organizationId, orgId),
        inArray(productsSchema.id, unique),
      ),
    );
  if (owned.length === 0) {
    return;
  }

  await tx.insert(supplierProductsSchema).values(
    owned.map(p => ({
      organizationId: orgId,
      supplierId,
      productId: p.id,
    })),
  );
}

// Minimal shape for the searchable selector inside Caja.
export type SupplierOption = {
  id: string;
  name: string;
  company: string | null;
};

export type SupplierKpis = {
  total: number;
  active: number;
  paidThisMonth: string;
  // "Pagos pendientes" requires Cuentas por Pagar (a future Compras module).
  // Until that obligation ledger exists there is nothing to derive it from, so
  // it stays null and the UI reserves the slot instead of inventing a number.
  pendingPayments: null;
};

const LIST_LIMIT = 200;

const DUP_TAX_ID = 'Ya existe un proveedor con ese NIT en este negocio';

export async function listSuppliers(
  params?: { search?: string },
): Promise<SupplierListItem[]> {
  const { orgId } = await requireOrgId();
  const search = params?.search?.trim();

  const filters = [eq(suppliersSchema.organizationId, orgId)];
  if (search) {
    const like = `%${search}%`;
    const searchFilter = or(
      ilike(suppliersSchema.name, like),
      ilike(suppliersSchema.email, like),
      ilike(suppliersSchema.phone, like),
      ilike(suppliersSchema.city, like),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  const [rows, payments] = await Promise.all([
    db
      .select()
      .from(suppliersSchema)
      .where(and(...filters))
      .orderBy(asc(suppliersSchema.name))
      .limit(LIST_LIMIT),
    db
      .select({
        supplierId: cashMovementsSchema.supplierId,
        totalPaid: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}), 0)::text`,
        lastPaymentAt: sql<Date | null>`MAX(${cashMovementsSchema.createdAt})`,
      })
      .from(cashMovementsSchema)
      .where(
        and(
          eq(cashMovementsSchema.organizationId, orgId),
          isNotNull(cashMovementsSchema.supplierId),
        ),
      )
      .groupBy(cashMovementsSchema.supplierId),
  ]);

  const paidMap = new Map<
    string,
    { totalPaid: string; lastPaymentAt: Date | null }
  >();
  for (const p of payments) {
    if (p.supplierId) {
      paidMap.set(p.supplierId, {
        totalPaid: p.totalPaid,
        lastPaymentAt: p.lastPaymentAt,
      });
    }
  }

  const productMap = await loadProductRefsBySupplier(
    orgId,
    rows.map(r => r.id),
  );

  return rows.map(r => ({
    ...r,
    totalPaid: paidMap.get(r.id)?.totalPaid ?? '0',
    lastPaymentAt: paidMap.get(r.id)?.lastPaymentAt ?? null,
    products: productMap.get(r.id) ?? [],
  }));
}

export async function listSuppliersForSelect(
  params?: { search?: string },
): Promise<SupplierOption[]> {
  const { orgId } = await requireOrgId();
  const search = params?.search?.trim();

  const filters = [
    eq(suppliersSchema.organizationId, orgId),
    eq(suppliersSchema.status, 'active'),
  ];
  if (search) {
    const like = `%${search}%`;
    const searchFilter = or(
      ilike(suppliersSchema.name, like),
      ilike(suppliersSchema.company, like),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  return db
    .select({
      id: suppliersSchema.id,
      name: suppliersSchema.name,
      company: suppliersSchema.company,
    })
    .from(suppliersSchema)
    .where(and(...filters))
    .orderBy(asc(suppliersSchema.name))
    .limit(LIST_LIMIT);
}

export async function getSupplierKpis(): Promise<SupplierKpis> {
  const { orgId } = await requireOrgId();

  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      active: sql<number>`(COUNT(*) FILTER (WHERE ${suppliersSchema.status} = 'active'))::int`,
    })
    .from(suppliersSchema)
    .where(eq(suppliersSchema.organizationId, orgId));

  const [paid] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${cashMovementsSchema.amount}), 0)::text`,
    })
    .from(cashMovementsSchema)
    .where(
      and(
        eq(cashMovementsSchema.organizationId, orgId),
        isNotNull(cashMovementsSchema.supplierId),
        gte(cashMovementsSchema.createdAt, sql`date_trunc('month', now())`),
      ),
    );

  return {
    total: counts?.total ?? 0,
    active: counts?.active ?? 0,
    paidThisMonth: paid?.total ?? '0',
    pendingPayments: null,
  };
}

export async function createSupplier(
  input: SupplierCreateInput,
): Promise<SupplierWithProducts> {
  const { userId, orgId } = await requireOrgId();
  const data = supplierCreateSchema.parse(input);

  try {
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(suppliersSchema)
        .values({
          organizationId: orgId,
          name: data.name,
          company: data.company ?? null,
          phone: data.phone ?? null,
          email: data.email ?? null,
          city: data.city ?? null,
          address: data.address ?? null,
          taxId: data.taxId ?? null,
          notes: data.notes ?? null,
          createdBy: userId,
        })
        .returning();

      if (!created) {
        throw new Error('Failed to create supplier');
      }

      await syncSupplierProducts(tx, orgId, created.id, data.productIds);
      return created;
    });

    revalidatePath('/dashboard/suppliers');
    return { ...row, products: await loadSupplierProducts(orgId, row.id) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(DUP_TAX_ID);
    }
    throw error;
  }
}

export async function updateSupplier(
  id: string,
  input: SupplierUpdateInput,
): Promise<SupplierWithProducts> {
  const { orgId } = await requireOrgId();
  const data = supplierUpdateSchema.parse(input);

  try {
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(suppliersSchema)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.company !== undefined && { company: data.company }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.city !== undefined && { city: data.city }),
          ...(data.address !== undefined && { address: data.address }),
          ...(data.taxId !== undefined && { taxId: data.taxId }),
          ...(data.notes !== undefined && { notes: data.notes }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(suppliersSchema.id, id),
            eq(suppliersSchema.organizationId, orgId),
          ),
        )
        .returning();

      if (!updated) {
        throw new Error('Supplier not found');
      }

      // undefined = caller didn't touch product assignments; leave them as-is.
      if (data.productIds !== undefined) {
        await syncSupplierProducts(tx, orgId, updated.id, data.productIds);
      }
      return updated;
    });

    revalidatePath('/dashboard/suppliers');
    return { ...row, products: await loadSupplierProducts(orgId, row.id) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(DUP_TAX_ID);
    }
    throw error;
  }
}

export async function setSupplierStatus(
  id: string,
  status: 'active' | 'archived',
): Promise<Supplier> {
  const { userId, orgId } = await requireOrgId();

  const [row] = await db
    .update(suppliersSchema)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(suppliersSchema.id, id), eq(suppliersSchema.organizationId, orgId)),
    )
    .returning();

  if (!row) {
    throw new Error('Supplier not found');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: status === 'archived' ? 'supplier.archived' : 'supplier.restored',
    entityType: 'supplier',
    entityId: row.id,
    after: { id: row.id, name: row.name, status: row.status },
  });

  revalidatePath('/dashboard/suppliers');
  return row;
}

// One row of the suppliers importer, already mapped from CSV/Excel/PDF/photo.
export type SupplierImportInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  taxId?: string | null;
};

export type ImportResult = {
  created: number;
  failed: { row: number; name: string; error: string }[];
};

const MAX_BULK_IMPORT = 2000;

// Bulk supplier import (the commit step of the suppliers importer). Best-effort by
// design: each row is its own insert, so one bad row (e.g. a duplicate NIT) is
// reported without aborting the whole batch. Reuses supplierCreateSchema so an
// imported supplier obeys the same rules as a single create (name + at least one
// contact). The grid validates rows before they ever reach here. Suppliers carry
// no product links on import — they are assigned later from the supplier modal.
export async function bulkImportSuppliers(
  rows: SupplierImportInput[],
): Promise<ImportResult> {
  const { userId, orgId } = await requireOrgId();
  const slice = rows.slice(0, MAX_BULK_IMPORT);
  const failed: ImportResult['failed'] = [];
  let created = 0;

  for (let i = 0; i < slice.length; i++) {
    const raw = slice[i]!;
    try {
      const data = supplierCreateSchema.parse({
        name: raw.name,
        phone: raw.phone ?? null,
        email: raw.email ?? null,
        city: raw.city ?? null,
        taxId: raw.taxId ?? null,
      });

      await db.insert(suppliersSchema).values({
        organizationId: orgId,
        name: data.name,
        company: null,
        phone: data.phone ?? null,
        email: data.email ?? null,
        city: data.city ?? null,
        address: null,
        taxId: data.taxId ?? null,
        notes: null,
        createdBy: userId,
      });

      created += 1;
    } catch (err) {
      failed.push({
        row: i + 1,
        name: raw.name?.trim() || '(sin nombre)',
        error: isUniqueViolation(err)
          ? DUP_TAX_ID
          : err instanceof Error
            ? err.message
            : 'Error inesperado',
      });
    }
  }

  if (created > 0) {
    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'supplier.bulk_imported',
      entityType: 'supplier',
      metadata: { created, failed: failed.length },
    });
    revalidatePath('/dashboard/suppliers');
  }

  return { created, failed };
}

export type ProductOption = { id: string; name: string };

// Products (id + name) to pick from when assigning what a supplier provides.
// Returns the full catalog (filtered by the search box as you type) — no cap, so
// every product is reachable from the picker.
export async function listSupplierProductOptions(
  params?: { search?: string },
): Promise<ProductOption[]> {
  const { orgId } = await requireOrgId();
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
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  return db
    .select({ id: productsSchema.id, name: productsSchema.name })
    .from(productsSchema)
    .where(and(...filters))
    .orderBy(asc(productsSchema.name));
}

// Contact data for an active supplier surfaced by the reverse lookup.
export type SupplierForProduct = {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
};

// Reverse lookup for restocking: given a product (e.g. one that ran out), the
// active suppliers that provide it, with the contact data needed to reach out.
// This is the entry point the agent uses to request more units.
export async function listSuppliersForProduct(
  productId: string,
): Promise<SupplierForProduct[]> {
  const { orgId } = await requireOrgId();

  return db
    .select({
      id: suppliersSchema.id,
      name: suppliersSchema.name,
      company: suppliersSchema.company,
      phone: suppliersSchema.phone,
      email: suppliersSchema.email,
    })
    .from(supplierProductsSchema)
    .innerJoin(
      suppliersSchema,
      eq(suppliersSchema.id, supplierProductsSchema.supplierId),
    )
    .where(
      and(
        eq(supplierProductsSchema.organizationId, orgId),
        eq(supplierProductsSchema.productId, productId),
        eq(suppliersSchema.status, 'active'),
      ),
    )
    .orderBy(asc(suppliersSchema.name));
}
