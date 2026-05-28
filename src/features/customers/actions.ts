'use server';

import type { CustomerCreateInput, CustomerUpdateInput } from './validation';
import { auth } from '@clerk/nextjs/server';
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { customersSchema } from '@/models/Schema';
import {

  customerCreateSchema,
  customerUpdateSchema,
  isConsumidorFinal,
} from './validation';

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

export type Customer = typeof customersSchema.$inferSelect;

export type CustomerListItem = Pick<
  Customer,
  | 'id'
  | 'name'
  | 'documentId'
  | 'whatsapp'
  | 'email'
  | 'address'
  | 'totalSpent'
  | 'lastPurchaseAt'
>;

const LIST_LIMIT = 100;

export async function listCustomers(
  params?: { search?: string },
): Promise<CustomerListItem[]> {
  const { orgId } = await requireOrgId();
  const search = params?.search?.trim();

  const filters = [
    eq(customersSchema.organizationId, orgId),
    eq(customersSchema.deleted, false),
  ];

  if (search) {
    const like = `%${search}%`;
    const searchFilter = or(
      ilike(customersSchema.name, like),
      ilike(customersSchema.documentId, like),
      ilike(customersSchema.whatsapp, like),
      ilike(customersSchema.email, like),
    );
    if (searchFilter) {
      filters.push(searchFilter);
    }
  }

  return db
    .select({
      id: customersSchema.id,
      name: customersSchema.name,
      documentId: customersSchema.documentId,
      whatsapp: customersSchema.whatsapp,
      email: customersSchema.email,
      address: customersSchema.address,
      totalSpent: customersSchema.totalSpent,
      lastPurchaseAt: customersSchema.lastPurchaseAt,
    })
    .from(customersSchema)
    .where(and(...filters))
    .orderBy(asc(customersSchema.name))
    .limit(LIST_LIMIT);
}

export async function createCustomer(input: CustomerCreateInput) {
  const { userId, orgId } = await requireOrgId();
  const data = customerCreateSchema.parse(input);

  if (isConsumidorFinal(data.name)) {
    throw new Error('"Consumidor Final" is reserved');
  }

  const [row] = await db
    .insert(customersSchema)
    .values({
      organizationId: orgId,
      name: data.name,
      documentId: data.documentId ?? null,
      whatsapp: data.whatsapp ?? null,
      email: data.email ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
      marketingOptIn: data.marketingOptIn ?? true,
      ...(data.totalSpent !== undefined && { totalSpent: data.totalSpent }),
      createdBy: userId,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create customer');
  }

  revalidatePath('/dashboard/customers');
  return row;
}

export async function updateCustomer(id: string, input: CustomerUpdateInput) {
  const { orgId } = await requireOrgId();
  const data = customerUpdateSchema.parse(input);

  const [row] = await db
    .update(customersSchema)
    .set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.documentId !== undefined && { documentId: data.documentId }),
      ...(data.whatsapp !== undefined && { whatsapp: data.whatsapp }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.address !== undefined && { address: data.address }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.marketingOptIn !== undefined && {
        marketingOptIn: data.marketingOptIn,
      }),
      ...(data.totalSpent !== undefined && { totalSpent: data.totalSpent }),
    })
    .where(
      and(
        eq(customersSchema.id, id),
        eq(customersSchema.organizationId, orgId),
        eq(customersSchema.deleted, false),
      ),
    )
    .returning();

  if (!row) {
    throw new Error('Customer not found');
  }

  revalidatePath('/dashboard/customers');
  return row;
}

export async function softDeleteCustomer(id: string) {
  const { userId, orgId } = await requireOrgId();

  const [existing] = await db
    .select()
    .from(customersSchema)
    .where(
      and(
        eq(customersSchema.id, id),
        eq(customersSchema.organizationId, orgId),
        eq(customersSchema.deleted, false),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error('Customer not found');
  }

  const [row] = await db
    .update(customersSchema)
    .set({ deleted: true })
    .where(
      and(
        eq(customersSchema.id, id),
        eq(customersSchema.organizationId, orgId),
        eq(customersSchema.deleted, false),
      ),
    )
    .returning({ id: customersSchema.id });

  if (!row) {
    throw new Error('Customer not found');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'customer.deleted',
    entityType: 'customer',
    entityId: existing.id,
    before: {
      id: existing.id,
      name: existing.name,
      documentId: existing.documentId,
      whatsapp: existing.whatsapp,
      email: existing.email,
      totalSpent: existing.totalSpent,
    },
  });

  revalidatePath('/dashboard/customers');
  return { id: row.id };
}
