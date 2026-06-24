'use server';

import { auth } from '@clerk/nextjs/server';
import { and, asc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/DB';
import { ensurePaymentMethodAccounts } from '@/libs/treasury';
import { paymentMethodsSchema } from '@/models/Schema';

export type PaymentMethodType = 'cash' | 'transfer' | 'card' | 'credit' | 'other';

export type PaymentMethodRow = typeof paymentMethodsSchema.$inferSelect;

const DEFAULT_SEED: ReadonlyArray<{
  name: string;
  type: PaymentMethodType;
  sortOrder: number;
}> = [
  // Solo se siembran los métodos gestionados por el sistema: Efectivo (siempre
  // activo) y Credito (controlado por el toggle credito-enabled). Las cuentas de
  // transferencia y tarjetas las agrega el negocio explícitamente con «Nuevo
  // método» — no se crean métodos que el usuario no configuró.
  { name: 'Efectivo', type: 'cash', sortOrder: 0 },
  { name: 'Crédito', type: 'credit', sortOrder: 1 },
];

async function requireOrg() {
  const { userId, orgId } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  return { userId, orgId };
}

async function requireAdminOrg() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage payment methods');
  }
  return { userId, orgId };
}

async function seedIfEmpty(orgId: string) {
  const existing = await db
    .select({ id: paymentMethodsSchema.id })
    .from(paymentMethodsSchema)
    .where(eq(paymentMethodsSchema.organizationId, orgId))
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  await db
    .insert(paymentMethodsSchema)
    .values(
      DEFAULT_SEED.map(item => ({
        organizationId: orgId,
        name: item.name,
        type: item.type,
        sortOrder: item.sortOrder,
      })),
    );
}

export async function listPaymentMethods(
  options?: { activeOnly?: boolean },
): Promise<PaymentMethodRow[]> {
  const { orgId } = await requireOrg();

  await seedIfEmpty(orgId);

  const where = options?.activeOnly
    ? and(
        eq(paymentMethodsSchema.organizationId, orgId),
        eq(paymentMethodsSchema.active, true),
      )
    : eq(paymentMethodsSchema.organizationId, orgId);

  return db
    .select()
    .from(paymentMethodsSchema)
    .where(where)
    .orderBy(asc(paymentMethodsSchema.sortOrder));
}

// Treasury attributes a confirmed transfer by matching the free-text
// sale_payments.method against the payment method name (resolveBancoForMethod,
// case-insensitive, exactly ONE active transfer). Two methods sharing a name make
// that match ambiguous, so the bank deposit silently never lands. Enforce unique
// names (case-insensitive, per org) at the source so attribution stays reliable.
async function assertNameAvailable(
  orgId: string,
  name: string,
  excludeId?: string,
) {
  const conditions = [
    eq(paymentMethodsSchema.organizationId, orgId),
    sql`lower(${paymentMethodsSchema.name}) = lower(${name})`,
  ];
  if (excludeId) {
    conditions.push(ne(paymentMethodsSchema.id, excludeId));
  }
  const [clash] = await db
    .select({ id: paymentMethodsSchema.id })
    .from(paymentMethodsSchema)
    .where(and(...conditions))
    .limit(1);
  if (clash) {
    throw new Error('Ya existe un método de pago con ese nombre');
  }
}

export type CreatePaymentMethodInput = {
  name: string;
  type: PaymentMethodType;
  icon?: string | null;
  sortOrder?: number;
  details?: Record<string, unknown>;
  description?: string | null;
};

export async function createPaymentMethod(
  input: CreatePaymentMethodInput,
): Promise<PaymentMethodRow> {
  const { orgId } = await requireAdminOrg();

  const name = input.name?.trim();
  if (!name) {
    throw new Error('name is required');
  }
  if (!input.type) {
    throw new Error('type is required');
  }

  await assertNameAvailable(orgId, name);

  const [row] = await db
    .insert(paymentMethodsSchema)
    .values({
      organizationId: orgId,
      name,
      type: input.type,
      icon: input.icon ?? null,
      sortOrder: input.sortOrder ?? 0,
      details: input.details ?? {},
      description: input.description ?? null,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create payment method');
  }

  // Creating a payment method "opens it in treasury": a money-holding method
  // (transfer/card/other) gets a linked banco account so transfers have a
  // destination. Best-effort — a failure here must not fail method creation.
  await ensurePaymentMethodAccounts(db, orgId, 'Sistema').catch(() => {});

  revalidatePath('/dashboard/settings');
  return row;
}

export type UpdatePaymentMethodInput = {
  id: string;
  name?: string;
  type?: PaymentMethodType;
  icon?: string | null;
  active?: boolean;
  sortOrder?: number;
  details?: Record<string, unknown>;
  description?: string | null;
};

export async function updatePaymentMethod(
  input: UpdatePaymentMethodInput,
): Promise<PaymentMethodRow> {
  const { orgId } = await requireAdminOrg();

  if (!input.id) {
    throw new Error('id is required');
  }

  const patch: Partial<typeof paymentMethodsSchema.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      throw new Error('name cannot be empty');
    }
    await assertNameAvailable(orgId, name, input.id);
    patch.name = name;
  }
  if (input.type !== undefined) {
    patch.type = input.type;
  }
  if (input.icon !== undefined) {
    patch.icon = input.icon;
  }
  if (input.active !== undefined) {
    patch.active = input.active;
  }
  if (input.sortOrder !== undefined) {
    patch.sortOrder = input.sortOrder;
  }
  if (input.details !== undefined) {
    patch.details = input.details;
  }
  if (input.description !== undefined) {
    patch.description = input.description;
  }

  const [row] = await db
    .update(paymentMethodsSchema)
    .set(patch)
    .where(
      and(
        eq(paymentMethodsSchema.id, input.id),
        eq(paymentMethodsSchema.organizationId, orgId),
      ),
    )
    .returning();

  if (!row) {
    throw new Error('Payment method not found');
  }

  revalidatePath('/dashboard/settings');
  return row;
}

// Borrado REAL. Es seguro porque sale_payments.method es texto (no FK a
// payment_methods): el historial de ventas conserva el nombre del método. Los
// métodos del sistema (cash/credit) no se pueden borrar — se gestionan con
// «Efectivo siempre activo» y el toggle de Credito.
export async function deletePaymentMethod(id: string): Promise<{ ok: true }> {
  const { orgId } = await requireAdminOrg();

  if (!id) {
    throw new Error('id is required');
  }

  const [row] = await db
    .delete(paymentMethodsSchema)
    .where(
      and(
        eq(paymentMethodsSchema.id, id),
        eq(paymentMethodsSchema.organizationId, orgId),
        notInArray(paymentMethodsSchema.type, ['cash', 'credit']),
      ),
    )
    .returning({ id: paymentMethodsSchema.id });

  if (!row) {
    throw new Error('Payment method not found');
  }

  revalidatePath('/dashboard/settings');
  return { ok: true as const };
}

// Persist a new ordering for the org's payment methods. Accepts an array of
// IDs in the desired display order; their sortOrder is rewritten to match the
// array index inside a single transaction.
export async function reorderPaymentMethods(
  orderedIds: string[],
): Promise<{ ok: true }> {
  const { orgId } = await requireAdminOrg();

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new Error('orderedIds must be a non-empty array');
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!id) {
        continue;
      }
      await tx
        .update(paymentMethodsSchema)
        .set({ sortOrder: i })
        .where(
          and(
            eq(paymentMethodsSchema.id, id),
            eq(paymentMethodsSchema.organizationId, orgId),
          ),
        );
    }
  });

  revalidatePath('/dashboard/settings');
  return { ok: true as const };
}
