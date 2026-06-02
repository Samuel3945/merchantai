'use server';

import { randomUUID } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import bcrypt from 'bcryptjs';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import {
  organizationPlansSchema,
  planAddonsSchema,
  posTokensSchema,
  posUsersSchema,
} from '@/models/Schema';

type PlanTier = 'free' | 'starter' | 'pro' | 'business';

// Cajas (POS device tokens) allowed per plan tier. Mirrors PLAN_CASHIER_LIMIT
// in employees.ts: you need at least one caja per cashier, so device slots
// track cashier slots. Extra slots are bought as `pos_device` add-ons.
const PLAN_POS_DEVICE_LIMIT: Record<PlanTier, number> = {
  free: 1,
  starter: 2,
  pro: 5,
  business: 10,
};

// Not exported: a "use server" module may only export async functions.
// Thrown by createPosToken and parsed by the client to show the upgrade CTA.
class PosDeviceLimitReachedError extends Error {
  readonly statusCode = 402;
  readonly code = 'pos_devices_limit_reached';
  readonly plan: PlanTier;
  readonly limit: number;
  readonly used: number;
  readonly base: number;
  readonly addons: number;

  constructor(payload: {
    plan: PlanTier;
    limit: number;
    used: number;
    base: number;
    addons: number;
  }) {
    super(
      `Pos devices limit reached: ${payload.used}/${payload.limit} on plan "${payload.plan}". ${JSON.stringify({
        code: 'pos_devices_limit_reached',
        ...payload,
      })}`,
    );
    this.name = 'PosDeviceLimitReachedError';
    this.plan = payload.plan;
    this.limit = payload.limit;
    this.used = payload.used;
    this.base = payload.base;
    this.addons = payload.addons;
  }
}

async function getOrganizationPlan(orgId: string): Promise<PlanTier> {
  const [row] = await db
    .select({ plan: organizationPlansSchema.plan })
    .from(organizationPlansSchema)
    .where(eq(organizationPlansSchema.organizationId, orgId))
    .limit(1);
  return (row?.plan as PlanTier | undefined) ?? 'free';
}

// Each active `pos_device` add-on row grants `qty` extra caja slots.
async function countPosDeviceAddons(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${planAddonsSchema.qty}), 0)` })
    .from(planAddonsSchema)
    .where(
      and(
        eq(planAddonsSchema.organizationId, orgId),
        eq(planAddonsSchema.addon, 'pos_device'),
        eq(planAddonsSchema.active, true),
      ),
    );
  return Number(row?.value ?? 0);
}

async function countActiveTokens(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.organizationId, orgId),
        eq(posTokensSchema.active, true),
      ),
    );
  return Number(row?.value ?? 0);
}

// PIN de caja: 4 a 8 dígitos, o '' para quitarlo (acceso directo con el token).
// Devuelve el hash bcrypt listo para persistir.
async function hashPinOrThrow(rawPin: string): Promise<string> {
  const pin = rawPin.trim();
  if (!pin) {
    return '';
  }
  if (!/^\d{4,8}$/.test(pin)) {
    throw new Error('El PIN debe tener entre 4 y 8 dígitos');
  }
  return bcrypt.hash(pin, 10);
}

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
  pin?: string;
};

export async function createPosToken(input: CreatePosTokenInput) {
  const { userId, orgId } = await requireAdminContext();

  const deviceName = input.deviceName?.trim();
  if (!deviceName) {
    throw new Error('deviceName is required');
  }

  // Plan quota: cap the number of active cajas (device tokens) per org.
  const [plan, used, addons] = await Promise.all([
    getOrganizationPlan(orgId),
    countActiveTokens(orgId),
    countPosDeviceAddons(orgId),
  ]);
  const base = PLAN_POS_DEVICE_LIMIT[plan];
  const limit = base + addons;
  if (used >= limit) {
    throw new PosDeviceLimitReachedError({ plan, limit, used, base, addons });
  }

  const cashierId = input.cashierId?.trim() || null;
  const expiresAt
    = input.expiresAt == null || input.expiresAt === ''
      ? null
      : new Date(input.expiresAt);

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error('expiresAt is not a valid date');
  }

  const pinHash = await hashPinOrThrow(input.pin ?? '');

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
      pin: pinHash,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to create POS token');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.created',
    entityType: 'pos_token',
    entityId: row.id,
    after: {
      deviceName: row.deviceName,
      cashierId: row.cashierId,
      expiresAt: row.expiresAt,
    },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return row;
}

export type PosDeviceQuota = {
  plan: PlanTier;
  used: number;
  base: number;
  addons: number;
  limit: number;
  remaining: number;
};

// Snapshot of caja usage for the admin hub — drives the usage meter and the
// "unlock more cajas" CTA proactively (before the user hits the 402 on create).
export async function getPosDeviceQuota(): Promise<PosDeviceQuota> {
  const { orgId } = await requireAdminContext();

  const [plan, used, addons] = await Promise.all([
    getOrganizationPlan(orgId),
    countActiveTokens(orgId),
    countPosDeviceAddons(orgId),
  ]);
  const base = PLAN_POS_DEVICE_LIMIT[plan];
  const limit = base + addons;

  return {
    plan,
    used,
    base,
    addons,
    limit,
    remaining: Math.max(0, limit - used),
  };
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
      hasPin: sql<boolean>`(${posTokensSchema.pin} <> '')`,
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

// Bloquear caja: active=false. No puede loguear ni sincronizar y libera cupo del
// plan, pero la fila persiste. Sube sessionEpoch para expulsar al empleado activo.
export async function blockPosToken(id: string) {
  const { userId, orgId } = await requireAdminContext();

  const [updated] = await db
    .update(posTokensSchema)
    .set({
      active: false,
      sessionEpoch: sql`${posTokensSchema.sessionEpoch} + 1`,
    })
    .where(
      and(
        eq(posTokensSchema.id, id),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posTokensSchema.id });

  if (!updated) {
    throw new Error('Caja no encontrada');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.blocked',
    entityType: 'pos_token',
    entityId: id,
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true as const };
}

// Desbloquear caja: active=true. Revalida el cupo del plan, porque una caja
// bloqueada no cuenta y reactivarla puede chocar contra el límite.
export async function unblockPosToken(id: string) {
  const { userId, orgId } = await requireAdminContext();

  const [plan, used, addons] = await Promise.all([
    getOrganizationPlan(orgId),
    countActiveTokens(orgId),
    countPosDeviceAddons(orgId),
  ]);
  const base = PLAN_POS_DEVICE_LIMIT[plan];
  const limit = base + addons;
  if (used >= limit) {
    throw new PosDeviceLimitReachedError({ plan, limit, used, base, addons });
  }

  const [updated] = await db
    .update(posTokensSchema)
    .set({ active: true })
    .where(
      and(
        eq(posTokensSchema.id, id),
        eq(posTokensSchema.organizationId, orgId),
        eq(posTokensSchema.active, false),
      ),
    )
    .returning({ id: posTokensSchema.id });

  if (!updated) {
    throw new Error('Caja no encontrada o ya activa');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.unblocked',
    entityType: 'pos_token',
    entityId: id,
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true as const };
}

// Eliminar caja: borra la fila por completo. Irreversible; el dispositivo pierde
// el acceso de inmediato y el cupo del plan queda libre.
export async function deletePosToken(id: string) {
  const { userId, orgId } = await requireAdminContext();

  const [deleted] = await db
    .delete(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.id, id),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({
      id: posTokensSchema.id,
      deviceName: posTokensSchema.deviceName,
    });

  if (!deleted) {
    throw new Error('Caja no encontrada');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.deleted',
    entityType: 'pos_token',
    entityId: id,
    before: { deviceName: deleted.deviceName },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true as const };
}

// Admin setea/cambia/quita el PIN de acceso de la caja. newPin='' => sin PIN.
export async function setPosTokenPin(id: string, newPin: string) {
  const { userId, orgId } = await requireAdminContext();

  const pinHash = await hashPinOrThrow(newPin ?? '');

  const [updated] = await db
    .update(posTokensSchema)
    .set({ pin: pinHash })
    .where(
      and(
        eq(posTokensSchema.id, id),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posTokensSchema.id });

  if (!updated) {
    throw new Error('Caja no encontrada');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.pin_changed',
    entityType: 'pos_token',
    entityId: id,
    metadata: { hasPin: pinHash !== '' },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true as const, hasPin: pinHash !== '' };
}

// Genera un token nuevo para la caja (invalida el anterior). El dispositivo que
// tenía el token viejo deberá pegar el nuevo. También sube el sessionEpoch.
export async function regeneratePosToken(id: string) {
  const { orgId } = await requireAdminContext();

  const newToken = randomUUID();
  const [updated] = await db
    .update(posTokensSchema)
    .set({
      token: newToken,
      sessionEpoch: sql`${posTokensSchema.sessionEpoch} + 1`,
    })
    .where(
      and(
        eq(posTokensSchema.id, id),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posTokensSchema.id, token: posTokensSchema.token });

  if (!updated) {
    throw new Error('POS token not found');
  }

  revalidatePath('/dashboard/pos-cajeros');
  return updated;
}

// "Cerrar sesión" de la caja: sube el sessionEpoch. El cajero lo detecta en su
// próximo /pos/me (≤30 s) y desloguea al empleado activo (vuelve al selector),
// sin invalidar el token de dispositivo.
export async function forceLogoutPosToken(id: string) {
  const { orgId } = await requireAdminContext();

  const [updated] = await db
    .update(posTokensSchema)
    .set({ sessionEpoch: sql`${posTokensSchema.sessionEpoch} + 1` })
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
