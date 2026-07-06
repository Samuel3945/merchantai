'use server';

import type { ActionResult } from '@/libs/action-result';
import { randomUUID } from 'node:crypto';
import { auth, currentUser } from '@clerk/nextjs/server';
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { ensureCajaForDevice } from '@/actions/cajas';
import { logAction } from '@/libs/audit-log';
import { db } from '@/libs/DB';
import { getOrgEntitlements, limitOf } from '@/libs/entitlements';
import { ensureOwnerCashier } from '@/libs/owner-cashier';
import { POS_DEVICES_LIMIT_REACHED } from '@/libs/plan-limits';
import {
  cajasSchema,
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

// ── Audit label resolvers ────────────────────────────────────────────────────
// A real audit stores READABLE before/after values, never raw UUIDs. We resolve
// the human label at WRITE time and freeze it into the audit blob, so the trail
// shows what the value WAS at that moment even if the address/account/cashier is
// later renamed or deleted. The id is kept alongside only for traceability.

/** Readable branch label for an address id (null = "Sin sucursal"). */
async function resolveAddressLabel(
  orgId: string,
  addressId: string | null,
): Promise<string> {
  if (!addressId) {
    return 'Sin sucursal';
  }
  const [row] = await db
    .select({
      name: orgAddressesSchema.name,
      address: orgAddressesSchema.address,
    })
    .from(orgAddressesSchema)
    .where(
      and(
        eq(orgAddressesSchema.id, addressId),
        eq(orgAddressesSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return 'Sucursal eliminada';
  }
  return row.name?.trim() || row.address;
}

/** Readable treasury account name for an account id (null = "Sin destino"). */
async function resolveAccountLabel(
  orgId: string,
  accountId: string | null,
): Promise<string> {
  if (!accountId) {
    return 'Sin destino';
  }
  const [row] = await db
    .select({ name: treasuryAccountsSchema.name })
    .from(treasuryAccountsSchema)
    .where(
      and(
        eq(treasuryAccountsSchema.id, accountId),
        eq(treasuryAccountsSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  return row?.name ?? 'Cuenta eliminada';
}

/** Readable cashier name for a pos_users id (null = "Sin cajero asignado"). */
async function resolveCashierLabel(
  orgId: string,
  cashierId: string | null,
): Promise<string> {
  if (!cashierId) {
    return 'Sin cajero asignado';
  }
  const [row] = await db
    .select({ name: posUsersSchema.name })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, cashierId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  return row?.name ?? 'Cajero eliminado';
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

// Qué bolsa de dinero (caja) recibe el nuevo dispositivo. Solo aplica al 2º+
// dispositivo; el 1º siempre estrena "Caja 1". 'shared' = comparte la bolsa de
// otro POS; 'exclusive' = su propia "Caja N". Omitido ⇒ exclusive (compat.).
export type CajaChoice
  = | { mode: 'exclusive' }
    | { mode: 'shared'; shareWithCajaId: string };

export type CreatePosTokenInput = {
  deviceName: string;
  /** Branch address for this caja (org_addresses.id). */
  addressId?: string | null;
  /**
   * PIN for the owner-admin operator. Used only the first time the owner becomes
   * an operator (when their operator profile still has no PIN); ignored after.
   */
  adminPin?: string | null;
  /** Money-bag decision for the 2nd+ device. Ignored for the 1st device. */
  cajaChoice?: CajaChoice;
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

  // Owner identity for the admin operator (email/name come from Clerk).
  const clerkUser = await currentUser();
  const owner = {
    clerkUserId: userId,
    email:
      clerkUser?.primaryEmailAddress?.emailAddress
      ?? clerkUser?.emailAddresses?.[0]?.emailAddress
      ?? '',
    name:
      clerkUser?.fullName
      || [clerkUser?.firstName, clerkUser?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim(),
  };

  // A caja is born ASSIGNED to a real operator (never null): the owner-admin by
  // default, so the device "¿quién sos?" selector is never empty and the
  // "Responsable" is always a person, not the caja. The owner can later hand the
  // caja to an employee (setCajaOperator). The PIN, when given, is set on the
  // owner operator's first caja.
  const { row, operatorId } = await db.transaction(async (tx) => {
    const operator = await ensureOwnerCashier(
      tx,
      orgId,
      owner,
      input.adminPin ?? undefined,
    );
    const [created] = await tx
      .insert(posTokensSchema)
      .values({
        organizationId: orgId,
        deviceName,
        createdBy: userId,
        addressId,
        cashierId: operator.id,
      })
      .returning();
    if (!created) {
      throw new Error('Failed to create POS token');
    }
    return { row: created, operatorId: operator.id };
  });

  // Todo dispositivo necesita una caja (bolsa de dinero) para vender.
  //  - 1er dispositivo (used === 0 antes de este insert): estrena "Caja 1", sin
  //    preguntar. Cualquier cajaChoice se ignora.
  //  - 2º+: honra la elección del dueño. 'shared' engancha la bolsa de otro POS;
  //    'exclusive' (o sin elección, por compat.) crea una nueva "Caja N".
  const sharedCajaId
    = used > 0 && input.cajaChoice?.mode === 'shared'
      ? input.cajaChoice.shareWithCajaId
      : null;
  if (sharedCajaId) {
    // La caja destino debe ser 'register', activa y de la misma org. Si no lo es,
    // cae a caja exclusiva para no dejar el dispositivo sin bolsa de dinero.
    const [target] = await db
      .select({ id: cajasSchema.id })
      .from(cajasSchema)
      .where(
        and(
          eq(cajasSchema.id, sharedCajaId),
          eq(cajasSchema.organizationId, orgId),
          eq(cajasSchema.type, 'register'),
          eq(cajasSchema.archived, false),
        ),
      )
      .limit(1);
    if (target) {
      await db
        .update(posTokensSchema)
        .set({ cajaId: target.id })
        .where(eq(posTokensSchema.id, row.id));
    } else {
      await ensureCajaForDevice(orgId, row.id, userId);
    }
  } else {
    await ensureCajaForDevice(orgId, row.id, userId);
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
      cashierId: operatorId,
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
      // Assigned default operator. Non-null = the owner-admin is this caja's
      // default responsable ("el admin hace de cajero" ON). Null = OFF.
      cashierId: posTokensSchema.cashierId,
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
      // Modo del cajón: 'shared' (compartida) | 'divided' (dividida). Ver
      // docs/caja-domiciliario/ESPECIFICACION.md §7.
      cashMode: posTokensSchema.cashMode,
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

  const [beforeAddress, afterAddress] = await Promise.all([
    resolveAddressLabel(orgId, current.addressId),
    resolveAddressLabel(orgId, updated.addressId),
  ]);
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.address_changed',
    entityType: 'pos_token',
    entityId: id,
    before: { addressId: current.addressId, address: beforeAddress },
    after: { addressId: updated.addressId, address: afterAddress },
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

  const [current] = await db
    .select({ allowOversell: posTokensSchema.allowOversell })
    .from(posTokensSchema)
    .where(
      and(eq(posTokensSchema.id, id), eq(posTokensSchema.organizationId, orgId)),
    )
    .limit(1);
  if (!current) {
    return { ok: false, error: 'Caja no encontrada' };
  }

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
    before: { allowOversell: current.allowOversell },
    after: { allowOversell: updated.allowOversell },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Genera un token nuevo para la caja (invalida el anterior). El dispositivo que
// tenía el token viejo deberá pegar el nuevo. También sube el sessionEpoch.
export async function regeneratePosToken(
  id: string,
): Promise<ActionResult<{ id: string; token: string }>> {
  const { userId, orgId } = await requireAdminContext();

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

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.access_regenerated',
    entityType: 'pos_token',
    entityId: id,
  });

  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: updated };
}

// Force-logout: increments sessionEpoch. Devices sending X-Pos-Session-Epoch
// get 401 session_revoked on their next /pos/me poll (≤30 s) and must log in
// again. The device token itself is not revoked.
export async function forceLogoutPosToken(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdminContext();

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

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.session_closed',
    entityType: 'pos_token',
    entityId: id,
  });

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

  const [current] = await db
    .select({
      destinationId: posTokensSchema.defaultSweepDestinationAccountId,
    })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.id, posTokenId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!current) {
    return { ok: false, error: 'Caja no encontrada' };
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

  const [beforeDestination, afterDestination] = await Promise.all([
    resolveAccountLabel(orgId, current.destinationId),
    resolveAccountLabel(orgId, accountId),
  ]);
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'pos_token.sweep_destination_changed',
    entityType: 'pos_token',
    entityId: posTokenId,
    before: {
      defaultSweepDestinationAccountId: current.destinationId,
      destination: beforeDestination,
    },
    after: {
      defaultSweepDestinationAccountId: accountId,
      destination: afterDestination,
    },
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

// "Cashier employee" = an ACTIVE non-admin operator who can run the POS (module
// 'pos'). They are the people who can take responsibility for a caja when the
// admin steps back, so this count gates turning the admin off as the responsable.
export async function countActiveCashierEmployees(orgId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
        ne(posUsersSchema.role, 'admin'),
        sql`'pos' = ANY(${posUsersSchema.enabledModules})`,
      ),
    );
  return Number(row?.value ?? 0);
}

// Does the org have at least one cashier employee to take a caja's responsibility?
// Drives the panel toggle: the admin can only step back as cashier when true.
export async function hasCashierEmployees(): Promise<boolean> {
  const { orgId } = await requireAdminContext();
  return (await countActiveCashierEmployees(orgId)) > 0;
}

// Per-caja switch "el admin hace de cajero". ON (the default) makes the owner-
// admin the caja's default responsable (cashier_id = owner operator). OFF clears
// it (cashier_id = null) so each cashier employee identifies themselves on the
// device. The admin can only turn it OFF when a cashier employee exists, so a
// caja is NEVER left without anyone who can be responsible.
export async function setAdminAsCashier(
  tokenId: string,
  enabled: boolean,
): Promise<ActionResult<{ id: string; adminAsCashier: boolean }>> {
  const { userId, orgId } = await requireAdminContext();

  const [current] = await db
    .select({ cashierId: posTokensSchema.cashierId })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.id, tokenId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!current) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  let nextCashierId: string | null;
  if (enabled) {
    // Re-affirm the owner as the caja's responsable (provision if needed).
    const clerkUser = await currentUser();
    const operator = await ensureOwnerCashier(db, orgId, {
      clerkUserId: userId,
      email:
        clerkUser?.primaryEmailAddress?.emailAddress
        ?? clerkUser?.emailAddresses?.[0]?.emailAddress
        ?? '',
      name:
        clerkUser?.fullName
        || [clerkUser?.firstName, clerkUser?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim(),
    });
    nextCashierId = operator.id;
  } else {
    // Stepping the admin back is only allowed if someone else can be responsible.
    if ((await countActiveCashierEmployees(orgId)) === 0) {
      return {
        ok: false,
        error:
          'No podés sacar al admin como cajero: primero dale permiso de caja a un empleado que se haga responsable.',
      };
    }
    nextCashierId = null;
  }

  const [updated] = await db
    .update(posTokensSchema)
    .set({ cashierId: nextCashierId })
    .where(
      and(
        eq(posTokensSchema.id, tokenId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .returning({
      id: posTokensSchema.id,
      cashierId: posTokensSchema.cashierId,
    });

  if (!updated) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  const [beforeCashier, afterCashier] = await Promise.all([
    resolveCashierLabel(orgId, current.cashierId),
    resolveCashierLabel(orgId, updated.cashierId),
  ]);
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: enabled
      ? 'pos_token.admin_cashier_on'
      : 'pos_token.admin_cashier_off',
    entityType: 'pos_token',
    entityId: tokenId,
    before: { cashierId: current.cashierId, cashier: beforeCashier },
    after: { cashierId: updated.cashierId, cashier: afterCashier },
  });

  revalidatePath('/dashboard/pos-cajeros');
  return {
    ok: true,
    data: { id: updated.id, adminAsCashier: updated.cashierId != null },
  };
}
