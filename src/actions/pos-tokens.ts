'use server';

import type { ActionResult } from '@/libs/action-result';
import { randomUUID } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { getOrgEntitlements, limitOf } from '@/libs/entitlements';
import { POS_DEVICES_LIMIT_REACHED } from '@/libs/plan-limits';
import {
  orgAddressesSchema,
  planAddonsSchema,
  posTokensSchema,
  posUsersSchema,
  treasuryAccountsSchema,
} from '@/models/Schema';

/** Validates an address id belongs to the org. Returns the id or null. */
async function resolveOrgAddressId(
  orgId: string,
  addressId: string | null | undefined,
): Promise<string | null> {
  const id = addressId?.trim() || null;
  if (!id) {
    return null;
  }
  const [row] = await db
    .select({ id: orgAddressesSchema.id })
    .from(orgAddressesSchema)
    .where(
      and(
        eq(orgAddressesSchema.id, id),
        eq(orgAddressesSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  return row ? row.id : null;
}

type PosToken = typeof posTokensSchema.$inferSelect;

type PosLimitMeta = {
  plan: string;
  limit: number;
  used: number;
  base: number;
  addons: number;
};

// Coded failure parsed by the client to render the "unlock more cajas" CTA with
// real numbers. Returned (not thrown) so the structured payload survives — Next
// masks thrown Server Action errors in production.
function posLimitReached(
  meta: PosLimitMeta,
): { ok: false; error: string; code: string; meta: PosLimitMeta } {
  return {
    ok: false,
    error: `Alcanzaste el límite de cajas de tu plan (${meta.used}/${meta.limit}).`,
    code: POS_DEVICES_LIMIT_REACHED,
    meta,
  };
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

async function requireAdminContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage POS tokens');
  }
  return { userId, orgId };
}

export type CreatePosTokenInput = {
  deviceName: string;
  /** Branch address for this caja (org_addresses.id). */
  addressId?: string | null;
};

// Register names must be unique per org (case-insensitive): audit trails and
// per-register sale attribution become ambiguous with two "Caja 1".
async function deviceNameTaken(
  orgId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: posTokensSchema.id })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.organizationId, orgId),
        sql`LOWER(${posTokensSchema.deviceName}) = LOWER(${name})`,
      ),
    )
    .limit(2);
  return rows.some(r => r.id !== excludeId);
}

export async function createPosToken(
  input: CreatePosTokenInput,
): Promise<ActionResult<PosToken>> {
  const { userId, orgId } = await requireAdminContext();

  const deviceName = input.deviceName?.trim();
  if (!deviceName) {
    return { ok: false, error: 'El nombre de la caja es obligatorio' };
  }

  if (await deviceNameTaken(orgId, deviceName)) {
    return {
      ok: false,
      error: 'Ya existe una caja con ese nombre. Usa un nombre distinto para no confundir la auditoría.',
    };
  }

  // Plan quota: cap the number of active cajas (device tokens) per org.
  const [entitlements, used, addons] = await Promise.all([
    getOrgEntitlements(orgId),
    countActiveTokens(orgId),
    countPosDeviceAddons(orgId),
  ]);
  const plan = entitlements.planSlug;
  const base = limitOf(entitlements, 'max_pos_devices', 1);
  const limit = base + addons;
  if (used >= limit) {
    return posLimitReached({ plan, limit, used, base, addons });
  }

  const addressId = await resolveOrgAddressId(orgId, input.addressId);

  // A caja is born with no operator, no assignment and no device PIN: it opens
  // with the token only (typed or scanned). Per-operator accountability is the
  // employee's personal PIN, verified on profile change at the device.
  const [row] = await db
    .insert(posTokensSchema)
    .values({
      organizationId: orgId,
      deviceName,
      createdBy: userId,
      addressId,
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
      addressId: row.addressId,
    },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: row };
}

export type PosDeviceQuota = {
  plan: string;
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

  const [entitlements, used, addons] = await Promise.all([
    getOrgEntitlements(orgId),
    countActiveTokens(orgId),
    countPosDeviceAddons(orgId),
  ]);
  const plan = entitlements.planSlug;
  const base = limitOf(entitlements, 'max_pos_devices', 1);
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
      // Live operator (stamped on profile change), not a static assignment.
      currentCashierId: posTokensSchema.currentCashierId,
      currentCashierName: posUsersSchema.name,
      currentCashierAt: posTokensSchema.currentCashierAt,
      addressId: posTokensSchema.addressId,
      addressName: orgAddressesSchema.name,
      address: orgAddressesSchema.address,
      addressCity: orgAddressesSchema.city,
      active: posTokensSchema.active,
      allowOversell: posTokensSchema.allowOversell,
      createdAt: posTokensSchema.createdAt,
      defaultSweepDestinationAccountId: posTokensSchema.defaultSweepDestinationAccountId,
    })
    .from(posTokensSchema)
    .leftJoin(
      posUsersSchema,
      eq(posUsersSchema.id, posTokensSchema.currentCashierId),
    )
    .leftJoin(
      orgAddressesSchema,
      eq(orgAddressesSchema.id, posTokensSchema.addressId),
    )
    .where(eq(posTokensSchema.organizationId, orgId))
    .orderBy(desc(posTokensSchema.createdAt));

  return rows;
}

// Bloquear caja: active=false. No puede loguear ni sincronizar y libera cupo del
// plan, pero la fila persiste. Sube sessionEpoch para expulsar al empleado activo.
export async function blockPosToken(
  id: string,
): Promise<ActionResult<{ id: string }>> {
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
    return { ok: false, error: 'Caja no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.blocked',
    entityType: 'pos_token',
    entityId: id,
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Desbloquear caja: active=true. Revalida el cupo del plan, porque una caja
// bloqueada no cuenta y reactivarla puede chocar contra el límite.
export async function unblockPosToken(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdminContext();

  const [entitlements, used, addons] = await Promise.all([
    getOrgEntitlements(orgId),
    countActiveTokens(orgId),
    countPosDeviceAddons(orgId),
  ]);
  const plan = entitlements.planSlug;
  const base = limitOf(entitlements, 'max_pos_devices', 1);
  const limit = base + addons;
  if (used >= limit) {
    return posLimitReached({ plan, limit, used, base, addons });
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
    return { ok: false, error: 'Caja no encontrada o ya activa' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.unblocked',
    entityType: 'pos_token',
    entityId: id,
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Eliminar caja: borra la fila por completo. Irreversible; el dispositivo pierde
// el acceso de inmediato y el cupo del plan queda libre.
export async function deletePosToken(
  id: string,
): Promise<ActionResult<{ id: string; deviceName: string }>> {
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
    return { ok: false, error: 'Caja no encontrada' };
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
  return { ok: true, data: deleted };
}

// Admin renombra la caja: cambia solo el deviceName. No toca el token ni el
// sessionEpoch, así que el dispositivo sigue conectado; solo cambia la etiqueta
// visible en el panel y en los modales.
export async function renamePosToken(
  id: string,
  newName: string,
): Promise<ActionResult<{ id: string; deviceName: string }>> {
  const { userId, orgId } = await requireAdminContext();

  const deviceName = newName?.trim();
  if (!deviceName) {
    return { ok: false, error: 'El nombre de la caja es obligatorio' };
  }

  const [current] = await db
    .select({ deviceName: posTokensSchema.deviceName })
    .from(posTokensSchema)
    .where(
      and(eq(posTokensSchema.id, id), eq(posTokensSchema.organizationId, orgId)),
    )
    .limit(1);

  if (!current) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  if (await deviceNameTaken(orgId, deviceName, id)) {
    return {
      ok: false,
      error: 'Ya existe una caja con ese nombre. Usa un nombre distinto para no confundir la auditoría.',
    };
  }

  const [updated] = await db
    .update(posTokensSchema)
    .set({ deviceName })
    .where(
      and(eq(posTokensSchema.id, id), eq(posTokensSchema.organizationId, orgId)),
    )
    .returning({
      id: posTokensSchema.id,
      deviceName: posTokensSchema.deviceName,
    });

  if (!updated) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.renamed',
    entityType: 'pos_token',
    entityId: id,
    before: { deviceName: current.deviceName },
    after: { deviceName: updated.deviceName },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Assigns (or clears) the branch address of a caja. addressId='' / null clears
// it, falling back to the legacy business_address in pos/connect.
export async function setPosTokenAddress(
  id: string,
  addressId: string | null,
): Promise<ActionResult<{ id: string; addressId: string | null }>> {
  const { userId, orgId } = await requireAdminContext();

  const [current] = await db
    .select({ addressId: posTokensSchema.addressId })
    .from(posTokensSchema)
    .where(
      and(eq(posTokensSchema.id, id), eq(posTokensSchema.organizationId, orgId)),
    )
    .limit(1);

  if (!current) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  const resolved = await resolveOrgAddressId(orgId, addressId);

  const [updated] = await db
    .update(posTokensSchema)
    .set({ addressId: resolved })
    .where(
      and(eq(posTokensSchema.id, id), eq(posTokensSchema.organizationId, orgId)),
    )
    .returning({
      id: posTokensSchema.id,
      addressId: posTokensSchema.addressId,
    });

  if (!updated) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.address_changed',
    entityType: 'pos_token',
    entityId: id,
    before: { addressId: current.addressId },
    after: { addressId: updated.addressId },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Per-caja "sell without stock control". When on, the POS sale/sync routes let
// this cajero complete a sale even with stock 0 (stock clamps at 0, FIFO values
// uncovered units at fallback cost). Owner-only.
export async function setPosTokenAllowOversell(
  id: string,
  allow: boolean,
): Promise<ActionResult<{ id: string; allowOversell: boolean }>> {
  const { userId, orgId } = await requireAdminContext();

  const [updated] = await db
    .update(posTokensSchema)
    .set({ allowOversell: allow })
    .where(
      and(eq(posTokensSchema.id, id), eq(posTokensSchema.organizationId, orgId)),
    )
    .returning({
      id: posTokensSchema.id,
      allowOversell: posTokensSchema.allowOversell,
    });

  if (!updated) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.oversell_changed',
    entityType: 'pos_token',
    entityId: id,
    after: { allowOversell: allow },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Genera un token nuevo para la caja (invalida el anterior). El dispositivo que
// tenía el token viejo deberá pegar el nuevo. También sube el sessionEpoch.
export async function regeneratePosToken(
  id: string,
): Promise<ActionResult<{ id: string; token: string }>> {
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
    return { ok: false, error: 'Caja no encontrada' };
  }

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Force-logout: increments sessionEpoch. Devices sending X-Pos-Session-Epoch
// get 401 session_revoked on their next /pos/me poll (≤30 s) and must log in
// again. The device token itself is not revoked.
export async function forceLogoutPosToken(
  id: string,
): Promise<ActionResult<{ id: string }>> {
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
    return { ok: false, error: 'Caja no encontrada' };
  }

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
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
  // Cajas never expire — a register is blocked explicitly, never by a date.
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

// ── Sweep destination config (treasury-sweep-model slice 2) ──────────────────

/**
 * Sets or clears the per-caja default sweep destination for a caja.
 * Owner-only (org:admin). The destination must be an active caja_fuerte owned
 * by the org. Pass accountId=null to clear the per-caja config (falls back to
 * global default or Pendiente de ubicar).
 */
export async function setPosTokenSweepDestination(
  posTokenId: string,
  accountId: string | null,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdminContext();

  if (accountId !== null) {
    // Validate: must be an active caja_fuerte in this org
    const [account] = await db
      .select({ id: treasuryAccountsSchema.id, type: treasuryAccountsSchema.type, active: treasuryAccountsSchema.active })
      .from(treasuryAccountsSchema)
      .where(
        and(
          eq(treasuryAccountsSchema.id, accountId),
          eq(treasuryAccountsSchema.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!account) {
      return { ok: false, error: 'Cuenta de destino no encontrada' };
    }
    if (!account.active) {
      return { ok: false, error: 'La cuenta de destino está inactiva' };
    }
    if (account.type !== 'caja_fuerte') {
      return {
        ok: false,
        error: 'Solo las cajas fuertes (cofres) pueden ser destino del traspaso automático',
      };
    }
  }

  const [updated] = await db
    .update(posTokensSchema)
    .set({ defaultSweepDestinationAccountId: accountId })
    .where(
      and(
        eq(posTokensSchema.id, posTokenId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({ id: posTokensSchema.id });

  if (!updated) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.sweep_destination_changed',
    entityType: 'pos_token',
    entityId: posTokenId,
    after: { defaultSweepDestinationAccountId: accountId },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
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
