'use server';

import { auth } from '@clerk/nextjs/server';
import { and, desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/libs/DB';
import { posTokensSchema, posUsersSchema } from '@/models/Schema';

async function requireAdminContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole && orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage POS tokens');
  }
  return { userId, orgId };
}

export type CreatePosTokenInput = {
  deviceName: string;
  cashierId?: string;
  expiresAt?: Date | string | null;
};

export async function createPosToken(input: CreatePosTokenInput) {
  const { userId, orgId } = await requireAdminContext();

  const deviceName = input.deviceName?.trim();
  if (!deviceName) {
    throw new Error('deviceName is required');
  }

  const cashierId = input.cashierId?.trim() || null;
  const expiresAt
    = input.expiresAt == null || input.expiresAt === ''
      ? null
      : new Date(input.expiresAt);

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error('expiresAt is not a valid date');
  }

  if (cashierId) {
    const [cashier] = await db
      .select({ id: posUsersSchema.id })
      .from(posUsersSchema)
      .where(
        and(
          eq(posUsersSchema.id, cashierId),
          eq(posUsersSchema.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!cashier) {
      throw new Error('Cashier not found in this organization');
    }
  }

  const [row] = await db
    .insert(posTokensSchema)
    .values({
      organizationId: orgId,
      deviceName,
      createdBy: userId,
      cashierId,
      expiresAt,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create POS token');
  }

  revalidatePath('/dashboard/pos-cajeros');
  return row;
}

export async function listPosTokens() {
  const { orgId } = await requireAdminContext();

  const rows = await db
    .select({
      id: posTokensSchema.id,
      token: posTokensSchema.token,
      storeId: posTokensSchema.storeId,
      deviceName: posTokensSchema.deviceName,
      createdBy: posTokensSchema.createdBy,
      cashierId: posTokensSchema.cashierId,
      cashierName: posUsersSchema.name,
      active: posTokensSchema.active,
      lastSyncAt: posTokensSchema.lastSyncAt,
      expiresAt: posTokensSchema.expiresAt,
      createdAt: posTokensSchema.createdAt,
    })
    .from(posTokensSchema)
    .leftJoin(posUsersSchema, eq(posUsersSchema.id, posTokensSchema.cashierId))
    .where(eq(posTokensSchema.organizationId, orgId))
    .orderBy(desc(posTokensSchema.createdAt));

  return rows;
}

export async function revokePosToken(id: string) {
  const { orgId } = await requireAdminContext();

  const [updated] = await db
    .update(posTokensSchema)
    .set({ active: false })
    .where(
      and(
        eq(posTokensSchema.id, id),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posTokensSchema.id });

  if (!updated) {
    throw new Error('POS token not found');
  }

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true as const };
}

export async function validatePosToken(token: string) {
  if (!token) {
    throw new Error('Token is required');
  }

  const [row] = await db
    .select()
    .from(posTokensSchema)
    .where(
      and(eq(posTokensSchema.token, token), eq(posTokensSchema.active, true)),
    )
    .limit(1);

  if (!row) {
    throw new Error('Token inválido o revocado');
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new Error('Token expirado');
  }
  return row;
}

export async function touchLastSync(token: string) {
  if (!token) {
    throw new Error('Token is required');
  }

  await db
    .update(posTokensSchema)
    .set({ lastSyncAt: new Date() })
    .where(eq(posTokensSchema.token, token));

  return { ok: true as const };
}

export async function listOrgCashiers() {
  const { orgId } = await requireAdminContext();

  const rows = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      email: posUsersSchema.email,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.role, 'cashier'),
        eq(posUsersSchema.active, true),
      ),
    )
    .orderBy(posUsersSchema.name);

  return rows;
}
