'use server';

import type { SupplierCreateInput, SupplierUpdateInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import { and, asc, eq, gte, ilike, isNotNull, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { isUniqueViolation } from '@/libs/action-result';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { cashMovementsSchema, suppliersSchema } from '@/models/Schema';
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

// A supplier row enriched with payment data derived live from the cash ledger —
// single source of truth, no stored aggregates that could drift.
export type SupplierListItem = Supplier & {
  lastPaymentAt: Date | null;
  totalPaid: string;
};

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
      ilike(suppliersSchema.company, like),
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

  return rows.map(r => ({
    ...r,
    totalPaid: paidMap.get(r.id)?.totalPaid ?? '0',
    lastPaymentAt: paidMap.get(r.id)?.lastPaymentAt ?? null,
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
): Promise<Supplier> {
  const { userId, orgId } = await requireOrgId();
  const data = supplierCreateSchema.parse(input);

  try {
    const [row] = await db
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

    if (!row) {
      throw new Error('Failed to create supplier');
    }

    revalidatePath('/dashboard/suppliers');
    return row;
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
): Promise<Supplier> {
  const { orgId } = await requireOrgId();
  const data = supplierUpdateSchema.parse(input);

  try {
    const [row] = await db
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

    if (!row) {
      throw new Error('Supplier not found');
    }

    revalidatePath('/dashboard/suppliers');
    return row;
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
