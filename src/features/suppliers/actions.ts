'use server';

import type { SupplierCreateInput, SupplierUpdateInput } from './validation';
import type { InvoiceContext } from '@/libs/supplier-invoice-payment';
import { auth } from '@clerk/nextjs/server';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isUniqueViolation } from '@/libs/action-result';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  listOpenInvoices,
  listOpenInvoicesForSupplier,
  recordInvoicePayment,
  resolveInvoiceInTx,
} from '@/libs/supplier-invoice-payment';
import { getSupplierKpisForOrg } from '@/libs/supplier-payables';
import { recordSupplierPaymentOutflow } from '@/libs/treasury';
import {
  productsSchema,
  stockMovementsSchema,
  supplierPayablesSchema,
  supplierPaymentsSchema,
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
  // SUM(supplier_payments.amount) in the current calendar month, org-scoped.
  // Reads supplier_payments only — NOT cash_movements (D6). POS cashier
  // "Pago a proveedor" gastos stay in expenses/P&L where they belong.
  paidThisMonth: string;
  // SUM(total_amount − paid_amount) for open+partial payables, org-scoped.
  // Returns '0' (not null) when no payables exist (REQ-5.4).
  pendingPayments: string;
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
    // Switch from cash_movements to supplier_payments (D6): panel purchases
    // never wrote cash_movements, so this is strictly more accurate. POS gasto
    // amounts stay in expenses/P&L where they belong — no double-count.
    db
      .select({
        supplierId: supplierPaymentsSchema.supplierId,
        totalPaid: sql<string>`COALESCE(SUM(${supplierPaymentsSchema.amount}), 0)::text`,
        lastPaymentAt: sql<Date | null>`MAX(${supplierPaymentsSchema.createdAt})`,
      })
      .from(supplierPaymentsSchema)
      .where(eq(supplierPaymentsSchema.organizationId, orgId))
      .groupBy(supplierPaymentsSchema.supplierId),
  ]);

  const paidMap = new Map<
    string,
    { totalPaid: string; lastPaymentAt: Date | null }
  >();
  for (const p of payments) {
    // supplierId is text NOT NULL in supplier_payments; the map key is the
    // suppliers.id uuid-as-text, matching how the entry flow stores it.
    paidMap.set(p.supplierId, {
      totalPaid: p.totalPaid,
      lastPaymentAt: p.lastPaymentAt,
    });
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

  // Delegate to the tested lib function so production and tests share one path.
  const kpis = await getSupplierKpisForOrg(db, orgId);

  return {
    total: counts?.total ?? 0,
    active: counts?.active ?? 0,
    paidThisMonth: kpis.paidThisMonth,
    pendingPayments: kpis.pendingPayments,
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

// ── "Compras por pagar" — Slice 3 ─────────────────────────────────────────────

// Executor type: real db singleton or a drizzle tx (same pattern as treasury.ts).
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One row in the "Compras por pagar" list. */
export type OpenPayable = {
  id: string;
  supplierId: string;
  supplierName: string | null;
  productName: string | null;
  totalAmount: string;
  paidAmount: string;
  outstanding: string;
  status: 'open' | 'partial';
  purchasedAt: Date;
};

/**
 * Lists all open or partial payables for the org, ordered newest-first.
 * Accepts an executor so it can be called from PGLite tests (lib-level)
 * or from server actions (using the real db singleton).
 *
 * Satisfies: REQ-6.1, REQ-6.2, REQ-6.5, REQ-6.6, SC-5.1–SC-5.5.
 */
export async function listOpenPayables(
  executor: Executor,
  organizationId: string,
): Promise<OpenPayable[]> {
  const rows = await executor
    .select({
      id: supplierPayablesSchema.id,
      supplierId: supplierPayablesSchema.supplierId,
      totalAmount: supplierPayablesSchema.totalAmount,
      paidAmount: supplierPayablesSchema.paidAmount,
      // creditedAmount: sum of all return credits applied (migration 0068).
      creditedAmount: supplierPayablesSchema.creditedAmount,
      status: supplierPayablesSchema.status,
      purchasedAt: supplierPayablesSchema.purchasedAt,
      // supplier name: null when supplier has been deleted (orphan payable)
      supplierName: suppliersSchema.name,
      // product name: pulled from the linked stock_movement row
      productName: stockMovementsSchema.productName,
    })
    .from(supplierPayablesSchema)
    .leftJoin(
      suppliersSchema,
      // supplierId is text (D1 — no FK, mirrors stock_movements.supplier_id).
      // Cast uuid to text for the join so PG's strict type system is satisfied.
      sql`${suppliersSchema.id}::text = ${supplierPayablesSchema.supplierId}`,
    )
    .leftJoin(
      stockMovementsSchema,
      eq(stockMovementsSchema.id, supplierPayablesSchema.stockMovementId),
    )
    .where(
      and(
        eq(supplierPayablesSchema.organizationId, organizationId),
        inArray(supplierPayablesSchema.status, ['open', 'partial']),
      ),
    )
    .orderBy(desc(supplierPayablesSchema.purchasedAt));

  return rows.map(r => ({
    id: r.id,
    supplierId: r.supplierId,
    supplierName: r.supplierName ?? null,
    productName: r.productName ?? null,
    totalAmount: r.totalAmount,
    paidAmount: r.paidAmount,
    // outstanding = total − paid − credited (migration 0068: subtract credits too).
    outstanding: (
      Number.parseFloat(r.totalAmount)
      - Number.parseFloat(r.paidAmount)
      - Number.parseFloat(r.creditedAmount ?? '0')
    ).toFixed(2),
    status: r.status as 'open' | 'partial',
    purchasedAt: r.purchasedAt,
  }));
}

/** Server-action wrapper for listOpenPayables (requires org from Clerk). */
export async function listOpenPayablesAction(): Promise<OpenPayable[]> {
  const { orgId } = await requireOrgId();
  return listOpenPayables(db, orgId);
}

export type RecordPayablePaymentInput = {
  organizationId: string;
  payableId: string;
  fromAccountId: string;
  amount: number | string;
  createdBy: string;
  note?: string | null;
};

export type RecordPayablePaymentResult = {
  paymentId: string;
  treasuryMovementId: string;
  payableStatus: 'open' | 'partial' | 'paid';
};

/**
 * Records a payment against an open/partial payable from the "Compras por pagar" view.
 *
 * Delegates to recordSupplierPaymentOutflow (Slice 2 helper, REQ-4.11) after
 * validating that the payable belongs to the org and is not already paid.
 * When executor is the real db singleton, recordSupplierPaymentOutflow opens
 * its own tx. When executor is a tx object (e.g. TenantDb), it nests directly.
 *
 * Satisfies: REQ-4.11, REQ-6.3, REQ-6.4, SC-5.3, SC-5.4, SC-6.1, SC-6.3.
 */
export async function recordPayablePayment(
  executor: Executor,
  input: RecordPayablePaymentInput,
): Promise<RecordPayablePaymentResult> {
  // Validate the payable belongs to this org and is not already paid.
  // The helper (recordSupplierPaymentOutflow) also validates this inside the tx;
  // this pre-check gives a clearer error surface before delegating.
  const [payable] = await executor
    .select({
      id: supplierPayablesSchema.id,
      organizationId: supplierPayablesSchema.organizationId,
      supplierId: supplierPayablesSchema.supplierId,
      status: supplierPayablesSchema.status,
    })
    .from(supplierPayablesSchema)
    .where(eq(supplierPayablesSchema.id, input.payableId))
    .limit(1);

  if (!payable) {
    throw new Error(`payable not found: ${input.payableId}`);
  }

  if (payable.organizationId !== input.organizationId) {
    throw new Error('payable does not belong to this organization');
  }

  if (payable.status === 'paid') {
    throw new Error('payable already paid — no additional payments accepted');
  }

  return recordSupplierPaymentOutflow(executor, {
    organizationId: input.organizationId,
    fromAccountId: input.fromAccountId,
    amount: input.amount,
    supplierId: payable.supplierId,
    payableId: input.payableId,
    note: input.note ?? null,
    createdBy: input.createdBy,
  });
}

const recordPayablePaymentSchema = z.object({
  payableId: z.string().uuid({ message: 'payableId debe ser un UUID válido' }),
  fromAccountId: z.string().uuid({ message: 'fromAccountId debe ser un UUID válido' }),
  amount: z
    .union([z.number(), z.string()])
    .transform(v => (typeof v === 'string' ? Number(v) : v))
    .refine(n => Number.isFinite(n) && n > 0, {
      message: 'El monto debe ser un número mayor a cero',
    }),
  note: z.string().nullish(),
});

/** Server-action wrapper for recordPayablePayment (requires org from Clerk). */
export async function recordPayablePaymentAction(input: {
  payableId: string;
  fromAccountId: string;
  amount: number | string;
  note?: string | null;
}): Promise<RecordPayablePaymentResult> {
  const { userId, orgId } = await requireOrgId();
  const data = recordPayablePaymentSchema.parse(input);
  const result = await recordPayablePayment(db, {
    organizationId: orgId,
    payableId: data.payableId,
    fromAccountId: data.fromAccountId,
    amount: data.amount,
    createdBy: userId,
    note: data.note ?? null,
  });
  revalidatePath('/[locale]/dashboard/suppliers/payables', 'page');
  return result;
}

// ── Invoice-grouped payables view ─────────────────────────────────────────────

export type { OpenInvoiceGroup } from '@/libs/supplier-invoice-payment';

/** Server-action wrapper for listOpenInvoices (requires org from Clerk). */
export async function listOpenInvoicesAction() {
  const { orgId } = await requireOrgId();
  return listOpenInvoices(db, orgId);
}

/** Lists open invoices for a specific supplier (for EntryModal picker). */
export async function listOpenInvoicesForSupplierAction(supplierId: string) {
  const { orgId } = await requireOrgId();
  return listOpenInvoicesForSupplier(db, orgId, supplierId);
}

const recordInvoicePaymentSchema = z.object({
  purchaseId: z.string().uuid(),
  fromAccountId: z.string().uuid(),
  amount: z
    .union([z.number(), z.string()])
    .transform(v => (typeof v === 'string' ? Number(v) : v))
    .refine(n => Number.isFinite(n) && n > 0, {
      message: 'El monto debe ser un número mayor a cero',
    }),
  note: z.string().nullish(),
});

/** Pays a supplier invoice as a unit, allocating oldest-first across its lines. */
export async function recordInvoicePaymentAction(input: {
  purchaseId: string;
  fromAccountId: string;
  amount: number | string;
  note?: string | null;
}) {
  const { userId, orgId } = await requireOrgId();
  const data = recordInvoicePaymentSchema.parse(input);
  const result = await recordInvoicePayment(db, {
    organizationId: orgId,
    purchaseId: data.purchaseId,
    fromAccountId: data.fromAccountId,
    amount: data.amount,
    createdBy: userId,
    note: data.note ?? null,
  });
  revalidatePath('/[locale]/dashboard/suppliers/payables', 'page');
  return result;
}

// ── resolveInvoiceInTx re-export for recordMovement integration ───────────────
// recordMovement (inventory.ts) calls this inside its own tx to stamp purchase_id.

export { resolveInvoiceInTx };
export type { InvoiceContext };
