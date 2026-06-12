'use server';

import type { ActionResult } from '@/libs/action-result';
import { auth } from '@clerk/nextjs/server';
import { and, count, desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { orgAddressesSchema, posTokensSchema } from '@/models/Schema';

// Admin-only context. Members never manage branch addresses.
async function requireAdminContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage addresses');
  }
  return { userId, orgId };
}

export type OrgAddress = typeof orgAddressesSchema.$inferSelect;

export type OrgAddressInput = {
  name?: string | null;
  address: string;
  city?: string | null;
};

/** Lists the org's reusable branch addresses, newest first. */
export async function listOrgAddresses(): Promise<OrgAddress[]> {
  const { orgId } = await requireAdminContext();

  return db
    .select()
    .from(orgAddressesSchema)
    .where(eq(orgAddressesSchema.organizationId, orgId))
    .orderBy(desc(orgAddressesSchema.createdAt));
}

export async function createOrgAddress(
  input: OrgAddressInput,
): Promise<ActionResult<OrgAddress>> {
  const { userId, orgId } = await requireAdminContext();

  const address = input.address?.trim();
  if (!address) {
    return { ok: false, error: 'La dirección es obligatoria' };
  }

  const [row] = await db
    .insert(orgAddressesSchema)
    .values({
      organizationId: orgId,
      name: input.name?.trim() || null,
      address,
      city: input.city?.trim() || null,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create address');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'org_address.created',
    entityType: 'org_address',
    entityId: row.id,
    after: { name: row.name, address: row.address, city: row.city },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: row };
}

export async function updateOrgAddress(
  id: string,
  input: OrgAddressInput,
): Promise<ActionResult<OrgAddress>> {
  const { userId, orgId } = await requireAdminContext();

  const address = input.address?.trim();
  if (!address) {
    return { ok: false, error: 'La dirección es obligatoria' };
  }

  const [updated] = await db
    .update(orgAddressesSchema)
    .set({
      name: input.name?.trim() || null,
      address,
      city: input.city?.trim() || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orgAddressesSchema.id, id),
        eq(orgAddressesSchema.organizationId, orgId),
      ),
    )
    .returning();

  if (!updated) {
    return { ok: false, error: 'Dirección no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'org_address.updated',
    entityType: 'org_address',
    entityId: updated.id,
    after: { name: updated.name, address: updated.address, city: updated.city },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

export async function deleteOrgAddress(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdminContext();

  // Guard: don't silently un-address cajas. Make the admin reassign first.
  const [inUse] = await db
    .select({ value: count() })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.organizationId, orgId),
        eq(posTokensSchema.addressId, id),
      ),
    );
  if (Number(inUse?.value ?? 0) > 0) {
    return {
      ok: false,
      error: 'Esta dirección está asignada a una o más cajas. Reasignalas antes de borrarla.',
    };
  }

  const [deleted] = await db
    .delete(orgAddressesSchema)
    .where(
      and(
        eq(orgAddressesSchema.id, id),
        eq(orgAddressesSchema.organizationId, orgId),
      ),
    )
    .returning({ id: orgAddressesSchema.id });

  if (!deleted) {
    return { ok: false, error: 'Dirección no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'org_address.deleted',
    entityType: 'org_address',
    entityId: id,
    after: { deleted: true },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: deleted };
}
