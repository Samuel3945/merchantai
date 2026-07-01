'use server';

import { and, desc, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { findOpenSession } from '@/libs/cash-helpers';
import { db } from '@/libs/DB';
import { getCurrentPanelUser, requirePanelModule } from '@/libs/panel-session';
import {
  cashSessionsSchema,
  courierShiftsSchema,
  posTokensSchema,
} from '@/models/Schema';

// A caja the courier can declare at shift start: an org cash session that is
// OPEN right now. `posTokenId` null = the admin/dashboard caja.
export type OpenCaja = {
  posTokenId: string | null;
  label: string;
};

// The courier's currently-active shift, with the human label of the caja every
// delivered order will be sold into.
export type ActiveCourierShift = {
  id: string;
  posTokenId: string | null;
  cajaLabel: string;
  startedAt: Date;
};

const ADMIN_CAJA_LABEL = 'Caja administración';

function cajaLabel(posTokenId: string | null, deviceName: string | null): string {
  if (posTokenId === null) {
    return ADMIN_CAJA_LABEL;
  }
  return deviceName ?? 'Caja';
}

// Every caja that is OPEN right now for the org, so the UI can offer the courier
// a real choice at shift start. Most-recently-opened first. Includes the
// admin/dashboard caja (posTokenId null) when its session is open.
export async function listOpenCajas(): Promise<OpenCaja[]> {
  const { orgId } = await requirePanelModule('delivery');

  const rows = await db
    .select({
      posTokenId: cashSessionsSchema.posTokenId,
      deviceName: posTokensSchema.deviceName,
    })
    .from(cashSessionsSchema)
    .leftJoin(
      posTokensSchema,
      eq(posTokensSchema.id, cashSessionsSchema.posTokenId),
    )
    .where(
      and(
        eq(cashSessionsSchema.organizationId, orgId),
        eq(cashSessionsSchema.status, 'open'),
      ),
    )
    .orderBy(desc(cashSessionsSchema.openedAt));

  return rows.map(r => ({
    posTokenId: r.posTokenId,
    label: cajaLabel(r.posTokenId, r.deviceName),
  }));
}

// Resolves the courier's active shift (endedAt IS NULL) with the caja label, or
// null when they have no open shift. Org-scoped and module-gated.
export async function getActiveCourierShift(): Promise<ActiveCourierShift | null> {
  const { userId, orgId } = await requirePanelModule('delivery');
  const courier = await getCurrentPanelUser(userId, orgId);
  if (!courier) {
    return null;
  }

  const [shift] = await db
    .select({
      id: courierShiftsSchema.id,
      posTokenId: courierShiftsSchema.posTokenId,
      startedAt: courierShiftsSchema.startedAt,
      deviceName: posTokensSchema.deviceName,
    })
    .from(courierShiftsSchema)
    .leftJoin(
      posTokensSchema,
      eq(posTokensSchema.id, courierShiftsSchema.posTokenId),
    )
    .where(
      and(
        eq(courierShiftsSchema.organizationId, orgId),
        eq(courierShiftsSchema.courierId, courier.id),
        isNull(courierShiftsSchema.endedAt),
      ),
    )
    .limit(1);

  if (!shift) {
    return null;
  }

  return {
    id: shift.id,
    posTokenId: shift.posTokenId,
    cajaLabel: cajaLabel(shift.posTokenId, shift.deviceName),
    startedAt: shift.startedAt,
  };
}

// Starts (or switches) the courier's shift against an EXISTING open caja.
//
// `posTokenId`: a device uuid to sell into that register's till, or null for the
// admin/dashboard caja.
//
// Safety choices:
//   - The caja MUST be a currently-OPEN cash session for the org (validated via
//     findOpenSession). We never open a caja here — the courier declares one the
//     owner already opened.
//   - If the courier already has an active shift on the SAME caja, this is an
//     idempotent no-op (returns it). If it's on a DIFFERENT caja, we END the old
//     shift and START a new one in a single transaction — the explicit, safe way
//     to switch caja without ever tripping the one-active-shift unique index.
export async function startCourierShift(
  posTokenId: string | null,
): Promise<ActiveCourierShift> {
  const { userId, orgId } = await requirePanelModule('delivery');

  const courier = await getCurrentPanelUser(userId, orgId);
  if (!courier) {
    // Only a linked employee (pos_users row) can be a courier — deliveries are
    // attributed to their id. An owner with no employee row cannot start a shift.
    throw new Error(
      'Tu usuario no está habilitado como domiciliario. Pedile al dueño que te cree un empleado con acceso a Domicilios.',
    );
  }

  // The declared caja must be OPEN right now (null = admin/dashboard session).
  const open = await findOpenSession(db, orgId, posTokenId);
  if (!open) {
    throw new Error(
      'La caja elegida no está abierta. Pedí que la abran antes de iniciar tu jornada.',
    );
  }

  // Resolve the device name once for the label the UI shows right after start
  // (it re-fetches getActiveCourierShift shortly after, which re-derives it).
  let deviceName: string | null = null;
  if (posTokenId !== null) {
    const [tok] = await db
      .select({ deviceName: posTokensSchema.deviceName })
      .from(posTokensSchema)
      .where(
        and(
          eq(posTokensSchema.id, posTokenId),
          eq(posTokensSchema.organizationId, orgId),
        ),
      )
      .limit(1);
    deviceName = tok?.deviceName ?? null;
  }
  const label = cajaLabel(posTokenId, deviceName);

  const [existing] = await db
    .select({
      id: courierShiftsSchema.id,
      posTokenId: courierShiftsSchema.posTokenId,
      startedAt: courierShiftsSchema.startedAt,
    })
    .from(courierShiftsSchema)
    .where(
      and(
        eq(courierShiftsSchema.organizationId, orgId),
        eq(courierShiftsSchema.courierId, courier.id),
        isNull(courierShiftsSchema.endedAt),
      ),
    )
    .limit(1);

  // Same caja → idempotent no-op.
  if (existing && existing.posTokenId === posTokenId) {
    return {
      id: existing.id,
      posTokenId: existing.posTokenId,
      cajaLabel: label,
      startedAt: existing.startedAt,
    };
  }

  const created = await db.transaction(async (tx) => {
    // Switching caja: end the previous shift first so the partial unique index
    // (one active shift per courier) is never violated by the insert below.
    if (existing) {
      await tx
        .update(courierShiftsSchema)
        .set({ endedAt: new Date() })
        .where(
          and(
            eq(courierShiftsSchema.id, existing.id),
            eq(courierShiftsSchema.organizationId, orgId),
            isNull(courierShiftsSchema.endedAt),
          ),
        );
    }

    const [row] = await tx
      .insert(courierShiftsSchema)
      .values({
        organizationId: orgId,
        courierId: courier.id,
        posTokenId,
      })
      .returning();

    if (!row) {
      throw new Error('No se pudo iniciar la jornada');
    }
    return row;
  });

  revalidatePath('/dashboard/delivery');

  return {
    id: created.id,
    posTokenId: created.posTokenId,
    cajaLabel: label,
    startedAt: created.startedAt,
  };
}

// Ends the courier's active shift (if any). Idempotent: a courier with no open
// shift is a silent no-op.
export async function endCourierShift(): Promise<void> {
  const { userId, orgId } = await requirePanelModule('delivery');
  const courier = await getCurrentPanelUser(userId, orgId);
  if (!courier) {
    return;
  }

  await db
    .update(courierShiftsSchema)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(courierShiftsSchema.organizationId, orgId),
        eq(courierShiftsSchema.courierId, courier.id),
        isNull(courierShiftsSchema.endedAt),
      ),
    );

  revalidatePath('/dashboard/delivery');
}
