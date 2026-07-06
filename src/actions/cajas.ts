'use server';

import type { ActionResult } from '@/libs/action-result';
import { auth } from '@clerk/nextjs/server';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { getCourierBalance } from '@/libs/courier-wallet';
import { db } from '@/libs/DB';
import { cajasSchema, posTokensSchema, posUsersSchema } from '@/models/Schema';

// Gestión de las CAJAS lógicas (bolsas de dinero), separadas del dispositivo POS.
// Ver migración 0089 + docs/caja-domiciliario. Una caja con 1 dispositivo es
// individual; con 2+ es compartida (misma bolsa). Una caja 'courier' es de un
// domiciliario (saldo derivado del ledger courier_cash_movements).

async function requireAdmin() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) {
    throw new Error('Not authenticated');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Solo el administrador puede gestionar las cajas');
  }
  return { userId, orgId };
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Nombre secuencial "Caja N" para una nueva caja de tipo 'register'. N = cantidad
// de cajas 'register' de la org (INCLUYENDO las archivadas) + 1, así el número no
// se reutiliza y la historia ("Caja 2, de … a …") queda estable aunque se archive.
export async function nextRegisterCajaName(
  executor: Executor,
  orgId: string,
): Promise<string> {
  const [row] = await executor
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(cajasSchema)
    .where(
      and(
        eq(cajasSchema.organizationId, orgId),
        eq(cajasSchema.type, 'register'),
      ),
    );
  return `Caja ${Number(row?.count ?? 0) + 1}`;
}

export type CajaDevice = { id: string; deviceName: string };

export type CajaConfig = {
  id: string;
  name: string;
  type: 'register' | 'courier';
  archived: boolean;
  courierId: string | null;
  courierName: string | null;
  devices: CajaDevice[];
  // Compartida = 2+ dispositivos en la misma bolsa.
  isShared: boolean;
  // Solo para cajas 'courier': saldo que el domiciliario lleva encima.
  courierBalance: number | null;
};

export type CajasOverview = {
  cajas: CajaConfig[];
  // Domiciliarios activos que aún no tienen una caja creada.
  couriersWithoutCaja: { id: string; name: string }[];
};

export async function listCajas(): Promise<CajasOverview> {
  const { orgId } = await requireAdmin();

  const rows = await db
    .select({
      id: cajasSchema.id,
      name: cajasSchema.name,
      type: cajasSchema.type,
      archived: cajasSchema.archived,
      courierId: cajasSchema.courierId,
      courierName: posUsersSchema.name,
    })
    .from(cajasSchema)
    .leftJoin(posUsersSchema, eq(posUsersSchema.id, cajasSchema.courierId))
    .where(
      and(eq(cajasSchema.organizationId, orgId), eq(cajasSchema.archived, false)),
    )
    .orderBy(asc(cajasSchema.createdAt));

  const devices = await db
    .select({
      id: posTokensSchema.id,
      deviceName: posTokensSchema.deviceName,
      cajaId: posTokensSchema.cajaId,
    })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.organizationId, orgId),
        eq(posTokensSchema.active, true),
      ),
    );

  const byCaja = new Map<string, CajaDevice[]>();
  for (const d of devices) {
    if (!d.cajaId) {
      continue;
    }
    const list = byCaja.get(d.cajaId) ?? [];
    list.push({ id: d.id, deviceName: d.deviceName });
    byCaja.set(d.cajaId, list);
  }

  const cajas: CajaConfig[] = [];
  for (const c of rows) {
    const cajaDevices = byCaja.get(c.id) ?? [];
    cajas.push({
      id: c.id,
      name: c.name,
      type: c.type,
      archived: c.archived,
      courierId: c.courierId,
      courierName: c.courierName,
      devices: cajaDevices,
      isShared: cajaDevices.length >= 2,
      courierBalance:
        c.type === 'courier' && c.courierId
          ? await getCourierBalance(orgId, c.courierId)
          : null,
    });
  }

  // Domiciliarios activos (módulo delivery) sin caja 'courier' activa.
  const couriers = await db
    .select({ id: posUsersSchema.id, name: posUsersSchema.name })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
        sql`'delivery' = ANY(${posUsersSchema.enabledModules})`,
      ),
    );
  const withCaja = new Set(
    rows.filter(r => r.type === 'courier' && r.courierId).map(r => r.courierId!),
  );
  const couriersWithoutCaja = couriers.filter(c => !withCaja.has(c.id));

  return { cajas, couriersWithoutCaja };
}

export type ArchivedCaja = {
  id: string;
  name: string;
  type: 'register' | 'courier';
  createdAt: Date;
  archivedAt: Date | null;
};

// Historial de cajas archivadas (quedaron vacías o el domiciliario se dio de
// baja). Da el "de {createdAt} a {archivedAt}" que se muestra en pos-cajeros.
export async function listArchivedCajas(): Promise<ArchivedCaja[]> {
  const { orgId } = await requireAdmin();
  return db
    .select({
      id: cajasSchema.id,
      name: cajasSchema.name,
      type: cajasSchema.type,
      createdAt: cajasSchema.createdAt,
      archivedAt: cajasSchema.archivedAt,
    })
    .from(cajasSchema)
    .where(
      and(eq(cajasSchema.organizationId, orgId), eq(cajasSchema.archived, true)),
    )
    .orderBy(desc(cajasSchema.archivedAt));
}

// Une un dispositivo a una caja existente (compartir) o lo mueve de caja. Si su
// caja anterior queda sin dispositivos, se archiva (border case acordado).
export async function assignDeviceToCaja(
  deviceId: string,
  cajaId: string,
): Promise<ActionResult<{ deviceId: string; cajaId: string }>> {
  const { userId, orgId } = await requireAdmin();

  const [device] = await db
    .select({ id: posTokensSchema.id, cajaId: posTokensSchema.cajaId })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.id, deviceId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!device) {
    return { ok: false, error: 'Dispositivo no encontrado' };
  }

  const [caja] = await db
    .select({ id: cajasSchema.id })
    .from(cajasSchema)
    .where(
      and(
        eq(cajasSchema.id, cajaId),
        eq(cajasSchema.organizationId, orgId),
        eq(cajasSchema.type, 'register'),
        eq(cajasSchema.archived, false),
      ),
    )
    .limit(1);
  if (!caja) {
    return { ok: false, error: 'Caja no encontrada' };
  }

  const previousCajaId = device.cajaId;

  await db
    .update(posTokensSchema)
    .set({ cajaId })
    .where(eq(posTokensSchema.id, deviceId));

  // Archiva la caja anterior si quedó sin dispositivos activos.
  if (previousCajaId && previousCajaId !== cajaId) {
    const [remaining] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(posTokensSchema)
      .where(
        and(
          eq(posTokensSchema.cajaId, previousCajaId),
          eq(posTokensSchema.active, true),
        ),
      );
    if (Number(remaining?.count ?? 0) === 0) {
      await db
        .update(cajasSchema)
        .set({ archived: true, archivedAt: new Date() })
        .where(eq(cajasSchema.id, previousCajaId));
    }
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'caja.device_assigned',
    entityType: 'caja',
    entityId: cajaId,
    after: { deviceId, cajaId, previousCajaId },
  });

  revalidatePath('/dashboard/cash');
  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: { deviceId, cajaId } };
}

// Saca un dispositivo de su caja compartida a una NUEVA caja individual propia.
export async function splitDeviceToOwnCaja(
  deviceId: string,
): Promise<ActionResult<{ deviceId: string; cajaId: string }>> {
  const { userId, orgId } = await requireAdmin();

  const [device] = await db
    .select({
      id: posTokensSchema.id,
      cajaId: posTokensSchema.cajaId,
    })
    .from(posTokensSchema)
    .where(
      and(
        eq(posTokensSchema.id, deviceId),
        eq(posTokensSchema.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!device) {
    return { ok: false, error: 'Dispositivo no encontrado' };
  }

  const [caja] = await db
    .insert(cajasSchema)
    .values({
      organizationId: orgId,
      name: await nextRegisterCajaName(db, orgId),
      type: 'register',
      createdBy: userId,
    })
    .returning({ id: cajasSchema.id });
  if (!caja) {
    return { ok: false, error: 'No se pudo crear la caja' };
  }

  const previousCajaId = device.cajaId;
  await db
    .update(posTokensSchema)
    .set({ cajaId: caja.id })
    .where(eq(posTokensSchema.id, deviceId));

  if (previousCajaId) {
    const [remaining] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(posTokensSchema)
      .where(
        and(
          eq(posTokensSchema.cajaId, previousCajaId),
          eq(posTokensSchema.active, true),
        ),
      );
    if (Number(remaining?.count ?? 0) === 0) {
      await db
        .update(cajasSchema)
        .set({ archived: true, archivedAt: new Date() })
        .where(eq(cajasSchema.id, previousCajaId));
    }
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'caja.device_split',
    entityType: 'caja',
    entityId: caja.id,
    after: { deviceId, cajaId: caja.id },
  });

  revalidatePath('/dashboard/cash');
  revalidatePath('/dashboard/pos-cajeros');
  return { ok: true, data: { deviceId, cajaId: caja.id } };
}

// Crea una caja para un domiciliario (su saldo vive en el ledger del bolsillo).
export async function createCourierCaja(
  courierId: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdmin();

  const [courier] = await db
    .select({ id: posUsersSchema.id, name: posUsersSchema.name })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, courierId),
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
      ),
    )
    .limit(1);
  if (!courier) {
    return { ok: false, error: 'Domiciliario no encontrado' };
  }

  // Idempotente: si ya existe una caja activa para ese domiciliario, no dupliques.
  const [existing] = await db
    .select({ id: cajasSchema.id })
    .from(cajasSchema)
    .where(
      and(
        eq(cajasSchema.organizationId, orgId),
        eq(cajasSchema.courierId, courierId),
        eq(cajasSchema.archived, false),
      ),
    )
    .limit(1);
  if (existing) {
    return { ok: true, data: { id: existing.id } };
  }

  const [caja] = await db
    .insert(cajasSchema)
    .values({
      organizationId: orgId,
      name: courier.name,
      type: 'courier',
      courierId,
      createdBy: userId,
    })
    .returning({ id: cajasSchema.id });
  if (!caja) {
    return { ok: false, error: 'No se pudo crear la caja' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'caja.courier_created',
    entityType: 'caja',
    entityId: caja.id,
    after: { courierId, name: courier.name },
  });

  revalidatePath('/dashboard/cash');
  return { ok: true, data: { id: caja.id } };
}

export async function renameCaja(
  id: string,
  name: string,
): Promise<ActionResult<{ id: string; name: string }>> {
  const { userId, orgId } = await requireAdmin();
  const clean = name.trim();
  if (!clean) {
    return { ok: false, error: 'El nombre es obligatorio' };
  }
  const [updated] = await db
    .update(cajasSchema)
    .set({ name: clean })
    .where(and(eq(cajasSchema.id, id), eq(cajasSchema.organizationId, orgId)))
    .returning({ id: cajasSchema.id, name: cajasSchema.name });
  if (!updated) {
    return { ok: false, error: 'Caja no encontrada' };
  }
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'caja.renamed',
    entityType: 'caja',
    entityId: id,
    after: { name: clean },
  });
  revalidatePath('/dashboard/cash');
  return { ok: true, data: updated };
}

// Archiva una caja de domiciliario (las de dispositivos se archivan solas al
// quedar sin dispositivos). No se permite archivar una caja con dispositivos.
export async function archiveCourierCaja(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdmin();
  const [caja] = await db
    .select({ id: cajasSchema.id, type: cajasSchema.type })
    .from(cajasSchema)
    .where(and(eq(cajasSchema.id, id), eq(cajasSchema.organizationId, orgId)))
    .limit(1);
  if (!caja) {
    return { ok: false, error: 'Caja no encontrada' };
  }
  if (caja.type !== 'courier') {
    return {
      ok: false,
      error: 'Solo se archivan cajas de domiciliario; quita los dispositivos primero.',
    };
  }
  await db
    .update(cajasSchema)
    .set({ archived: true, archivedAt: new Date() })
    .where(eq(cajasSchema.id, id));
  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'caja.archived',
    entityType: 'caja',
    entityId: id,
    after: { archived: true },
  });
  revalidatePath('/dashboard/cash');
  return { ok: true, data: { id } };
}

// Crea la caja individual de un dispositivo recién creado (llamado desde
// createPosToken). Todo dispositivo necesita una caja para vender.
export async function ensureCajaForDevice(
  orgId: string,
  deviceId: string,
  createdBy: string,
): Promise<void> {
  const [device] = await db
    .select({ cajaId: posTokensSchema.cajaId })
    .from(posTokensSchema)
    .where(eq(posTokensSchema.id, deviceId))
    .limit(1);
  if (device?.cajaId) {
    return;
  }
  const [caja] = await db
    .insert(cajasSchema)
    .values({
      organizationId: orgId,
      name: await nextRegisterCajaName(db, orgId),
      type: 'register',
      createdBy,
    })
    .returning({ id: cajasSchema.id });
  if (caja) {
    await db
      .update(posTokensSchema)
      .set({ cajaId: caja.id })
      .where(eq(posTokensSchema.id, deviceId));
  }
}
